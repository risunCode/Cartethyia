package outbound

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Code is the stable machine-readable classifier for outbound policy errors.
// Error text is diagnostic only and MUST NOT be used for branching.
type Code string

const (
	CodeInvalidURL        Code = "outbound.invalid_url"
	CodeUnsupportedScheme Code = "outbound.unsupported_scheme"
	CodePrivateAddress    Code = "outbound.private_address"
	CodeResolutionFailed  Code = "outbound.resolution_failed"
	CodeRedirectDenied    Code = "outbound.redirect_denied"
	CodeProxyUnavailable  Code = "outbound.proxy_unavailable"
	CodeProxyUnhealthy    Code = "outbound.proxy_unhealthy"
	CodeConnectionFailed  Code = "outbound.connection_failed"
	CodeContextInvalid    Code = "outbound.invalid_context"
)

var (
	ErrInvalidURL        = errors.New("outbound: invalid upstream URL")
	ErrPrivateAddress    = errors.New("outbound: private or reserved address denied")
	ErrUnsupportedScheme = errors.New("outbound: unsupported scheme")
	ErrResolutionFailed  = errors.New("outbound: DNS resolution failed")
	ErrRedirectDenied    = errors.New("outbound: redirect denied")
	ErrProxyUnavailable  = errors.New("outbound: proxy health unavailable")
	ErrProxyUnhealthy    = errors.New("outbound: proxy is unhealthy or disabled")
	ErrConnectionFailed  = errors.New("outbound: connection failed")
	ErrInvalidContext    = errors.New("outbound: context is nil")
)

// Error is returned for every outbound policy rejection or invalid operation.
// Code is stable; Cause and the diagnostic message are intentionally
// subordinate to it.
type Error struct {
	Code   Code
	Cause  error
	Detail string
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Detail == "" {
		if e.Cause != nil {
			return fmt.Sprintf("%s: %v", e.Code, e.Cause)
		}
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Detail)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Is allows callers to match either the stable code or the package sentinel.
func (e *Error) Is(target error) bool {
	if other, ok := target.(*Error); ok && other != nil {
		return e.Code == other.Code
	}
	return errors.Is(e.Cause, target)
}

func policyError(code Code, cause error, detail string) error {
	return &Error{Code: code, Cause: cause, Detail: detail}
}

// ErrorCode extracts the stable code from an outbound policy error.
func ErrorCode(err error) Code {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		return typed.Code
	}
	return ""
}

// CodeOf is an alias for ErrorCode for callers that prefer code-oriented
// naming.
func CodeOf(err error) Code { return ErrorCode(err) }

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

// ProxyHealth exposes the health gate used when a request is routed through a
// named outbound proxy. Implementations can be backed by the proxy selector
// package without importing it (and therefore without creating a cycle).
type ProxyHealth interface {
	IsHealthy(proxyID string, now time.Time) bool
}

type proxyEnabled interface {
	IsEnabled(proxyID string) bool
}

const (
	defaultResolveTimeout = 5 * time.Second
	defaultRequestTimeout = 30 * time.Second
)

type Policy struct {
	AllowLoopback bool
	AllowPrivate  bool
	Resolver      Resolver
	AllowedHosts  map[string]struct{}
	MaxRedirects  int

	// ResolveTimeout bounds each DNS lookup. A non-positive value uses the
	// conservative default.
	ResolveTimeout time.Duration
	// RequestTimeout bounds the complete HTTP operation, including redirects.
	// A non-positive value uses the conservative default.
	RequestTimeout time.Duration

	// ProxyID and ProxyHealth are optional. When ProxyID is set, a health hook
	// is mandatory and is checked before every connection, including redirects.
	ProxyID     string
	ProxyHealth ProxyHealth
}

func (p Policy) Validate(ctx context.Context, raw string) (*url.URL, error) {
	if ctx == nil {
		return nil, policyError(CodeContextInvalid, ErrInvalidContext, "")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, policyError(CodeInvalidURL, ErrInvalidURL, err.Error())
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		if scheme == "" {
			return nil, policyError(CodeInvalidURL, ErrInvalidURL, "scheme is required")
		}
		return nil, policyError(CodeUnsupportedScheme, ErrUnsupportedScheme, scheme)
	}
	if u.Host == "" || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return nil, policyError(CodeInvalidURL, ErrInvalidURL, "absolute URL without userinfo, opaque data, or fragment is required")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" || strings.ContainsAny(host, " \t\r\n\x00") || strings.Contains(host, "%") {
		return nil, policyError(CodeInvalidURL, ErrInvalidURL, "host is malformed")
	}
	if looksLikeObfuscatedIP(host) && net.ParseIP(host) == nil {
		return nil, policyError(CodeInvalidURL, ErrInvalidURL, "numeric IP notation is not accepted")
	}
	if len(p.AllowedHosts) > 0 {
		if _, ok := p.AllowedHosts[host]; !ok {
			allowed := false
			for candidate := range p.AllowedHosts {
				if strings.ToLower(strings.TrimSuffix(candidate, ".")) == host {
					allowed = true
					break
				}
			}
			if !allowed {
				return nil, policyError(CodeInvalidURL, ErrInvalidURL, "host is not allowlisted")
			}
		}
	}
	if err := p.validateProxy(); err != nil {
		return nil, err
	}
	if err := p.validateHost(ctx, host); err != nil {
		return nil, err
	}
	u.Scheme = scheme
	return u, nil
}

func (p Policy) validateProxy() error {
	if p.ProxyID == "" {
		return nil
	}
	if p.ProxyHealth == nil {
		return policyError(CodeProxyUnavailable, ErrProxyUnavailable, "proxy health hook is required")
	}
	if enabled, ok := p.ProxyHealth.(proxyEnabled); ok && !enabled.IsEnabled(p.ProxyID) {
		return policyError(CodeProxyUnhealthy, ErrProxyUnhealthy, "proxy is disabled")
	}
	if !p.ProxyHealth.IsHealthy(p.ProxyID, time.Now()) {
		return policyError(CodeProxyUnhealthy, ErrProxyUnhealthy, "proxy is not healthy")
	}
	return nil
}

func looksLikeObfuscatedIP(host string) bool {
	if host == "" {
		return false
	}
	allDigitsOrDots := true
	allHexOrDots := true
	for _, ch := range host {
		if (ch < '0' || ch > '9') && ch != '.' {
			allDigitsOrDots = false
		}
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') || ch == '.' || ch == 'x') {
			allHexOrDots = false
		}
	}
	return allDigitsOrDots || (allHexOrDots && strings.Contains(host, "x"))
}

func (p Policy) validateHost(ctx context.Context, host string) error {
	ips, err := p.lookup(ctx, host)
	if err != nil {
		return err
	}
	for _, ip := range ips {
		if ip == nil {
			return policyError(CodeResolutionFailed, ErrResolutionFailed, "resolver returned an invalid address")
		}
		if ip.IsMulticast() || isReservedIP(ip) {
			return policyError(CodePrivateAddress, ErrPrivateAddress, "multicast or reserved address")
		}
		if !p.AllowLoopback && ip.IsLoopback() {
			return policyError(CodePrivateAddress, ErrPrivateAddress, "loopback address")
		}
		if !p.AllowPrivate && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast()) {
			return policyError(CodePrivateAddress, ErrPrivateAddress, "private, link-local, or unspecified address")
		}
	}
	return nil
}

func (p Policy) lookup(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	timeout := p.ResolveTimeout
	if timeout <= 0 {
		timeout = defaultResolveTimeout
	}
	lookupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var (
		addrs []net.IPAddr
		err   error
	)
	if p.Resolver != nil {
		result := make(chan lookupResult, 1)
		go func() {
			resolved, resolveErr := p.Resolver.LookupIPAddr(lookupCtx, host)
			result <- lookupResult{addrs: resolved, err: resolveErr}
		}()
		select {
		case resolved := <-result:
			addrs, err = resolved.addrs, resolved.err
		case <-lookupCtx.Done():
			return nil, policyError(CodeResolutionFailed, ErrResolutionFailed, fmt.Sprintf("resolve %q: %v", host, lookupCtx.Err()))
		}
	} else {
		addrs, err = net.DefaultResolver.LookupIPAddr(lookupCtx, host)
	}
	if err != nil {
		detail := fmt.Sprintf("resolve %q: %v", host, err)
		if lookupCtx.Err() != nil {
			detail = fmt.Sprintf("resolve %q: %v", host, lookupCtx.Err())
		}
		return nil, policyError(CodeResolutionFailed, fmt.Errorf("%w: %v", ErrResolutionFailed, err), detail)
	}
	if len(addrs) == 0 {
		return nil, policyError(CodeResolutionFailed, ErrResolutionFailed, fmt.Sprintf("resolve %q returned no addresses", host))
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		ips = append(ips, addr.IP)
	}
	return ips, nil
}

type lookupResult struct {
	addrs []net.IPAddr
	err   error
}

func isReservedIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() {
		return false
	}
	for _, network := range reservedNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

var reservedNetworks = parseReservedNetworks()

func parseReservedNetworks() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24",
		"192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"100::/64", "2001:2::/48", "2001:db8::/32", "3fff::/20",
	}
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(cidr)
		if err == nil {
			out = append(out, network)
		}
	}
	return out
}

func (p Policy) Client(base http.RoundTripper) *http.Client {
	if base == nil {
		base = http.DefaultTransport
	}
	timeout := p.RequestTimeout
	if timeout <= 0 {
		timeout = defaultRequestTimeout
	}
	return &http.Client{
		Transport: &validatingTransport{policy: p, base: p.wrapTransport(base)},
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			max := p.MaxRedirects
			if max <= 0 || len(via) > max {
				return policyError(CodeRedirectDenied, ErrRedirectDenied, "redirect limit exceeded")
			}
			if req == nil || req.URL == nil {
				return policyError(CodeRedirectDenied, ErrRedirectDenied, "redirect target is missing")
			}
			if _, err := p.Validate(req.Context(), req.URL.String()); err != nil {
				return policyError(CodeRedirectDenied, fmt.Errorf("%w: %w", ErrRedirectDenied, err), err.Error())
			}
			return nil
		},
	}
}

type validatingTransport struct {
	policy Policy
	base   http.RoundTripper
}

func (t *validatingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, policyError(CodeInvalidURL, ErrInvalidURL, "request URL is missing")
	}
	if _, err := t.policy.Validate(req.Context(), req.URL.String()); err != nil {
		return nil, err
	}
	return t.base.RoundTrip(req)
}

func (p Policy) wrapTransport(base http.RoundTripper) http.RoundTripper {
	transport, ok := base.(*http.Transport)
	if !ok {
		return base
	}
	clone := transport.Clone()
	// A proxy transport resolves the destination itself. Validate the target
	// above, but do not replace its proxy dialer with a direct dial.
	if clone.Proxy == nil {
		originalDial := clone.DialContext
		clone.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return p.dialContext(ctx, network, address, originalDial)
		}
	}
	return clone
}

func (p Policy) dialContext(ctx context.Context, network, address string, base func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, policyError(CodeConnectionFailed, ErrConnectionFailed, err.Error())
	}
	ips, err := p.lookup(ctx, strings.Trim(host, "[]"))
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if ip == nil || ip.IsMulticast() || isReservedIP(ip) ||
			(!p.AllowLoopback && ip.IsLoopback()) ||
			(!p.AllowPrivate && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast())) {
			return nil, policyError(CodePrivateAddress, ErrPrivateAddress, "resolved connection address is unsafe")
		}
	}
	dial := base
	if dial == nil {
		d := net.Dialer{}
		dial = d.DialContext
	}
	conn, err := dial(ctx, network, net.JoinHostPort(ips[0].String(), port))
	if err != nil {
		return nil, policyError(CodeConnectionFailed, fmt.Errorf("%w: %v", ErrConnectionFailed, err), err.Error())
	}
	return conn, nil
}
