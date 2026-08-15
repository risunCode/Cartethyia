package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	proxy "github.com/cartethyia/daemon/internal/proxy/runtime"
	"github.com/cartethyia/daemon/internal/security/outbound"
	xproxy "golang.org/x/net/proxy"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const DefaultMaxResponseBytes = 16 << 20

type CredentialResolver func(context.Context, string) (string, error)

// ProxySelector chooses an outbound proxy for one provider/account request.
// The release callback owns the selector's concurrency reservation and is
// called when the request or stream lifecycle ends.
type ProxySelection struct {
	URL           *url.URL
	ID            string
	Probe         bool
	ReportSuccess bool
	Release       func()
}

type ProxySelector func(context.Context, string, string) (ProxySelection, error)
type ProxyFailureRecorder func(context.Context, string, string, string)
type ProxySuccessRecorder func(context.Context, string)

type HTTPTransport struct {
	Registry          *providers.Registry
	Client            *http.Client
	ProxySelector     ProxySelector
	ProxyFailure      ProxyFailureRecorder
	ProxySuccess      ProxySuccessRecorder
	BaseURLs          map[string]string
	ResolveCredential CredentialResolver
	OutboundPolicy    *outbound.Policy
	MaxResponseBytes  int64
	MaxSSELineBytes   int
	MaxSSEEventBytes  int
	ConnectTimeout    time.Duration
	FirstByteTimeout  time.Duration
	TotalTimeout      time.Duration
	IdleTimeout       time.Duration
	clientOnce        sync.Once
	configuredClient  *http.Client
}

type proxyAttemptOutcome struct {
	transport     *HTTPTransport
	proxyID       string
	reportSuccess bool
	callerCtx     context.Context
	once          sync.Once
}

func (o *proxyAttemptOutcome) failure(ctx context.Context, kind, message string, cause error) {
	if o == nil || o.transport == nil || o.proxyID == "" || ctx == nil {
		return
	}
	if o.callerCtx != nil {
		if o.callerCtx.Err() != nil {
			return
		}
		ctx = o.callerCtx
	} else if ctx.Err() != nil || errors.Is(cause, context.Canceled) {
		return
	}
	o.once.Do(func() {
		o.transport.recordProxyFailure(ctx, o.proxyID, kind, message)
	})
}

func (o *proxyAttemptOutcome) success(ctx context.Context) {
	if o == nil || o.transport == nil || o.proxyID == "" || !o.reportSuccess || ctx == nil {
		return
	}
	if o.callerCtx != nil {
		if o.callerCtx.Err() != nil {
			return
		}
		ctx = o.callerCtx
	} else if ctx.Err() != nil {
		return
	}
	o.once.Do(func() {
		o.transport.recordProxySuccess(ctx, o.proxyID)
	})
}

func (t *HTTPTransport) Call(ctx context.Context, acct proxy.Account, req contracts.Request) (*contracts.Response, error) {
	if t == nil || t.Registry == nil {
		return nil, errors.New("transport: provider registry is required")
	}
	requestCtx, cancel := t.withTotalTimeout(ctx)
	defer cancel()
	providerID := providerFor(acct, req)
	p, err := t.Registry.Get(providerID)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.unavailable", "provider unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
	}
	surface := req.Protocol
	if (providerID == "openai" || providerID == "codex") && surface == providers.SurfaceOpenAIChat {
		surface = providers.SurfaceOpenAIResponses
	}
	target, err := p.ResolveTarget(req.Model, surface)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorInvalidRequest, providerID, req.Model, "provider.unsupported_route", "model or surface unsupported", false, false, contracts.RateScopeRoute, contracts.RatePhasePreDispatch)
	}
	credential, err := t.resolve(requestCtx, acct.CredentialRef.String())
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorAuthentication, providerID, req.Model, "provider.credential_unavailable", "credential unavailable", true, false, contracts.RateScopeAccount, contracts.RatePhasePreDispatch)
	}
	built, err := p.BuildRequest(providers.RequestEnvelope{Target: target, Body: req.Body, Stream: req.Stream, Headers: req.Headers}, credential)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorInvalidRequest, providerID, req.Model, "provider.request_invalid", "provider request invalid", false, false, contracts.RateScopeRoute, contracts.RatePhasePreDispatch)
	}
	selection, err := t.selectProxy(requestCtx, providerID, acct.ID)
	if err != nil {
		return nil, transportRouteError(requestCtx, providerID, req.Model, true, "proxy selection failed", err)
	}
	proxy.RecordAttemptNetwork(requestCtx, selection.ID != "", selection.ID)
	if selection.Release == nil {
		selection.Release = func() {}
	}
	defer selection.Release()
	outcome := &proxyAttemptOutcome{transport: t, proxyID: selection.ID, reportSuccess: selection.ReportSuccess, callerCtx: ctx}
	client, err := t.clientForProxy(selection.URL)
	if err != nil {
		return nil, transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "proxy transport unavailable", err)
	}
	endpoint, err := t.endpoint(providerID, built.Endpoint)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.endpoint_invalid", "provider endpoint unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
	}
	httpReq, err := t.newRequest(requestCtx, built, endpoint, "application/json")
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.request_unavailable", "provider request unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		outcome.failure(requestCtx, proxyTransportFailureKind(err), "provider transport failed", err)
		return nil, transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "provider transport failed", err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, t.maxBytes()+1))
	resp.Body.Close()
	if readErr != nil {
		outcome.failure(requestCtx, "body_read", "provider response read failed", readErr)
		return nil, transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "provider response read failed", readErr)
	}
	outcome.success(requestCtx)
	if int64(len(body)) > t.maxBytes() {
		return nil, &contracts.RouteError{
			Kind: contracts.ErrorFatal, StatusCode: resp.StatusCode, Provider: providerID, Model: req.Model,
			Code: "provider.response_too_large", Message: "provider response exceeded bound",
			RateScope: contracts.RateScopeProvider, RatePhase: contracts.RatePhaseProvider,
			Scope: contracts.RateScopeProvider, Phase: contracts.RatePhaseProvider,
		}
	}
	evidence := providers.NewResponseEvidence(resp.StatusCode, resp.Header, body)
	classified := p.ClassifyResponse(evidence)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return &contracts.Response{StatusCode: resp.StatusCode, Headers: resp.Header.Clone(), Body: body}, nil
	}
	routeErr := classifiedRouteError(requestCtx, providerID, req.Model, classified)
	if repairer, ok := p.(providers.RepairProposer); ok {
		return nil, proxy.WithRepairRule(routeErr, repairer.RepairRule(evidence))
	}
	return nil, routeErr
}

func (t *HTTPTransport) CallStream(ctx context.Context, acct proxy.Account, req contracts.Request) (*proxy.Stream, error) {
	if t == nil || t.Registry == nil {
		return nil, errors.New("transport: provider registry is required")
	}
	requestCtx, totalCancel := t.withTotalTimeout(ctx)
	streamStarted := false
	defer func() {
		if !streamStarted {
			totalCancel()
		}
	}()
	providerID := providerFor(acct, req)
	p, err := t.Registry.Get(providerID)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.unavailable", "provider unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
	}
	surface := req.Protocol
	if (providerID == "openai" || providerID == "codex") && surface == providers.SurfaceOpenAIChat {
		surface = providers.SurfaceOpenAIResponses
	}
	target, err := p.ResolveTarget(req.Model, surface)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorInvalidRequest, providerID, req.Model, "provider.unsupported_route", "model or surface unsupported", false, false, contracts.RateScopeRoute, contracts.RatePhasePreDispatch)
	}
	credential, err := t.resolve(requestCtx, acct.CredentialRef.String())
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorAuthentication, providerID, req.Model, "provider.credential_unavailable", "credential unavailable", true, false, contracts.RateScopeAccount, contracts.RatePhasePreDispatch)
	}
	built, err := p.BuildRequest(providers.RequestEnvelope{Target: target, Body: req.Body, Stream: true, Headers: req.Headers}, credential)
	if err != nil {
		return nil, setupRouteError(requestCtx, contracts.ErrorInvalidRequest, providerID, req.Model, "provider.request_invalid", "provider request invalid", false, false, contracts.RateScopeRoute, contracts.RatePhasePreDispatch)
	}
	selection, err := t.selectProxy(requestCtx, providerID, acct.ID)
	if err != nil {
		return nil, transportRouteError(requestCtx, providerID, req.Model, true, "proxy selection failed", err)
	}
	proxy.RecordAttemptNetwork(requestCtx, selection.ID != "", selection.ID)
	if selection.Release == nil {
		selection.Release = func() {}
	}
	outcome := &proxyAttemptOutcome{transport: t, proxyID: selection.ID, reportSuccess: selection.ReportSuccess, callerCtx: ctx}
	client, err := t.clientForProxy(selection.URL)
	if err != nil {
		selection.Release()
		return nil, transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "proxy transport unavailable", err)
	}
	endpoint, err := t.endpoint(providerID, built.Endpoint)
	if err != nil {
		selection.Release()
		return nil, setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.endpoint_invalid", "provider endpoint unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
	}
	streamCtx, cancel := context.WithCancel(requestCtx)
	cancelAll := func() {
		selection.Release()
		cancel()
		totalCancel()
	}
	httpReq, err := t.newRequest(streamCtx, built, endpoint, "text/event-stream")
	if err != nil {
		routeErr := setupRouteError(requestCtx, contracts.ErrorFatal, providerID, req.Model, "provider.request_unavailable", "provider request unavailable", false, false, contracts.RateScopeProvider, contracts.RatePhasePreDispatch)
		cancelAll()
		return nil, routeErr
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		outcome.failure(requestCtx, proxyTransportFailureKind(err), "provider transport failed", err)
		routeErr := transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "provider transport failed", err)
		cancelAll()
		return nil, routeErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, t.maxBytes()+1))
		resp.Body.Close()
		defer cancelAll()
		if readErr != nil {
			outcome.failure(requestCtx, "body_read", "provider response read failed", readErr)
			return nil, transportRouteError(requestCtx, providerID, req.Model, selection.ID != "", "provider response read failed", readErr)
		}
		outcome.success(requestCtx)
		if int64(len(body)) > t.maxBytes() {
			return nil, &contracts.RouteError{
				Kind: contracts.ErrorFatal, StatusCode: resp.StatusCode, Provider: providerID, Model: req.Model,
				Code: "provider.response_too_large", Message: "provider response exceeded bound",
				RateScope: contracts.RateScopeProvider, RatePhase: contracts.RatePhaseProvider,
				Scope: contracts.RateScopeProvider, Phase: contracts.RatePhaseProvider,
			}
		}
		evidence := providers.NewResponseEvidence(resp.StatusCode, resp.Header, body)
		classified := p.ClassifyResponse(evidence)
		routeErr := classifiedRouteError(requestCtx, providerID, req.Model, classified)
		if repairer, ok := p.(providers.RepairProposer); ok {
			return nil, proxy.WithRepairRule(routeErr, repairer.RepairRule(evidence))
		}
		return nil, routeErr
	}
	if !isSSEMediaType(resp.Header.Get("Content-Type")) {
		resp.Body.Close()
		outcome.failure(requestCtx, "stream_media_type", "provider stream media type invalid", errors.New("invalid stream media type"))
		routeErr := setupRouteError(requestCtx, contracts.ErrorTransient, providerID, req.Model, "provider.stream_media_type_invalid", "provider stream media type invalid", true, true, contracts.RateScopeProvider, contracts.RatePhaseProvider)
		cancelAll()
		return nil, routeErr
	}
	repairProposer, _ := p.(providers.RepairProposer)
	ch := make(chan proxy.StreamEvent, 16)
	s := proxy.NewStream(ch, cancelAll, t.IdleTimeout, 0)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		send := func(event proxy.StreamEvent) bool {
			select {
			case ch <- event:
				return true
			case <-streamCtx.Done():
				return false
			}
		}
		decoder := newSSEDecoder(resp.Body, t.maxSSELineBytes(), t.maxSSEEventBytes())
		for {
			event, decodeErr := decoder.Next()
			if decodeErr != nil {
				if streamCtx.Err() != nil {
					return
				}
				failure, kind, message := sseStreamFailure(decodeErr)
				if isProxyStreamFailure(decodeErr) {
					outcome.failure(requestCtx, kind, message, decodeErr)
				}
				_ = send(failure)
				return
			}
			if isSSEDone(event.Data) {
				outcome.success(requestCtx)
				_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop, Reason: "completed"})
				return
			}
			if repairProposer != nil {
				evidence := providers.NewResponseEvidence(resp.StatusCode, resp.Header, event.Data)
				if ruleID := repairProposer.RepairRule(evidence); ruleID != "" {
					outcome.success(requestCtx)
					marked := proxy.WithRepairRule(proxy.ErrInvalidEncryptedContent, ruleID)
					_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop, Err: marked, Reason: "error"})
					return
				}
			}
			mapped, mapErr := proxy.MapProviderPayload(proxy.ProviderStreamPayload{Data: event.Data, Event: event.Event, ID: event.ID})
			if mapErr != nil {
				_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop, Err: mapErr, Reason: "error"})
				return
			}
			terminal := false
			for _, canonical := range mapped {
				if !send(canonical) {
					return
				}
				terminal = terminal || canonical.IsTerminal()
			}
			if terminal {
				outcome.success(requestCtx)
				return
			}
		}
	}()
	streamStarted = true
	return s, nil
}

// ProposeRepair delegates a signaled compatibility rule to the active
// provider. It is pure: the router alone applies the returned body and decides
// whether another globally-counted upstream attempt is available.
func (t *HTTPTransport) ProposeRepair(acct proxy.Account, req contracts.Request, ruleID string) (providers.RepairProposal, bool) {
	if t == nil || t.Registry == nil || ruleID == "" {
		return providers.RepairProposal{}, false
	}
	providerID := providerFor(acct, req)
	p, err := t.Registry.Get(providerID)
	if err != nil {
		return providers.RepairProposal{}, false
	}
	repairer, ok := p.(providers.RepairProposer)
	if !ok {
		return providers.RepairProposal{}, false
	}
	surface := req.Protocol
	if (providerID == "openai" || providerID == "codex") && surface == providers.SurfaceOpenAIChat {
		surface = providers.SurfaceOpenAIResponses
	}
	target, err := p.ResolveTarget(req.Model, surface)
	if err != nil {
		return providers.RepairProposal{}, false
	}
	proposal, ok := repairer.ProposeRepair(ruleID, providers.RequestEnvelope{
		Target: target, Body: req.Body, Stream: req.Stream, Headers: req.Headers,
	})
	if !ok || proposal.RuleID != ruleID {
		return providers.RepairProposal{}, false
	}
	return proposal, true
}

func sseStreamFailure(err error) (proxy.StreamEvent, string, string) {
	code := proxy.StreamCodeUpstreamTruncated
	cause := proxy.ErrStreamTruncated
	kind := "stream_truncated"
	message := "provider stream ended before terminal event"
	var decodeErr *sseDecodeError
	if errors.As(err, &decodeErr) {
		switch decodeErr.kind {
		case sseFailureRead:
			code = proxy.StreamCodeReadFailure
			cause = proxy.ErrStreamUpstream
			kind = "stream_read"
			message = "provider stream read failed"
		case sseFailureMalformed:
			code = proxy.StreamCodeMalformedEvent
			cause = proxy.ErrStreamMalformed
			kind = "stream_malformed"
			message = "provider stream framing malformed"
		case sseFailureOversized:
			code = proxy.StreamCodeEventTooLarge
			cause = proxy.ErrStreamMalformed
			kind = "stream_oversized"
			message = "provider stream event exceeded bound"
		}
	}
	return proxy.StreamEvent{
		Kind:   proxy.EventMessageStop,
		Reason: "error",
		Err:    &proxy.StreamError{Code: code, Message: message, Err: cause},
	}, kind, message
}

func isProxyStreamFailure(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var decodeErr *sseDecodeError
	return errors.As(err, &decodeErr) && (decodeErr.kind == sseFailureRead || decodeErr.kind == sseFailureTruncated)
}

func proxyTransportFailureKind(err error) string {
	var opErr *net.OpError
	if errors.As(err, &opErr) && (opErr.Op == "dial" || opErr.Op == "proxyconnect") {
		return "connect"
	}
	var tlsHeader *tls.RecordHeaderError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalidCertificate x509.CertificateInvalidError
	if errors.As(err, &tlsHeader) || errors.As(err, &unknownAuthority) || errors.As(err, &hostname) || errors.As(err, &invalidCertificate) {
		return "tls"
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "tls") || strings.Contains(lower, "certificate") || strings.Contains(lower, "x509") {
		return "tls"
	}
	return "header"
}

func (t *HTTPTransport) resolve(ctx context.Context, ref string) (string, error) {
	if t.ResolveCredential == nil {
		return ref, nil
	}
	return t.ResolveCredential(ctx, ref)
}

func (t *HTTPTransport) selectProxy(ctx context.Context, providerID, accountID string) (ProxySelection, error) {
	if t.ProxySelector == nil {
		return ProxySelection{Release: func() {}}, nil
	}
	return t.ProxySelector(ctx, providerID, accountID)
}

func (t *HTTPTransport) recordProxyFailure(ctx context.Context, proxyID, kind, message string) {
	if t.ProxyFailure != nil && proxyID != "" {
		t.ProxyFailure(ctx, proxyID, kind, message)
	}
}

func (t *HTTPTransport) recordProxySuccess(ctx context.Context, proxyID string) {
	if t.ProxySuccess != nil && proxyID != "" {
		t.ProxySuccess(ctx, proxyID)
	}
}

func (t *HTTPTransport) clientForProxy(proxyURL *url.URL) (*http.Client, error) {
	if proxyURL == nil {
		return t.client(), nil
	}
	base := t.Client
	var transport *http.Transport
	if base != nil {
		var ok bool
		transport, ok = base.Transport.(*http.Transport)
		if !ok {
			return nil, errors.New("transport: configured client does not expose an HTTP transport")
		}
		transport = transport.Clone()
	} else {
		transport = http.DefaultTransport.(*http.Transport).Clone()
		if t.ConnectTimeout > 0 {
			transport.DialContext = (&net.Dialer{Timeout: t.ConnectTimeout}).DialContext
			transport.TLSHandshakeTimeout = t.ConnectTimeout
		}
		if t.FirstByteTimeout > 0 {
			transport.ResponseHeaderTimeout = t.FirstByteTimeout
		}
		if t.IdleTimeout > 0 {
			transport.IdleConnTimeout = t.IdleTimeout
		}
	}
	if strings.EqualFold(proxyURL.Scheme, "socks5") || strings.EqualFold(proxyURL.Scheme, "socks5h") {
		var auth *xproxy.Auth
		if proxyURL.User != nil {
			password, _ := proxyURL.User.Password()
			auth = &xproxy.Auth{User: proxyURL.User.Username(), Password: password}
		}
		dialer, err := xproxy.SOCKS5("tcp", proxyURL.Host, auth, &net.Dialer{Timeout: t.ConnectTimeout})
		if err != nil {
			return nil, err
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if contextDialer, ok := dialer.(interface {
				DialContext(context.Context, string, string) (net.Conn, error)
			}); ok {
				return contextDialer.DialContext(ctx, network, address)
			}
			return dialer.Dial(network, address)
		}
	} else if strings.EqualFold(proxyURL.Scheme, "http") || strings.EqualFold(proxyURL.Scheme, "https") {
		transport.Proxy = http.ProxyURL(proxyURL)
	} else {
		return nil, errors.New("transport: unsupported proxy protocol")
	}
	if base == nil {
		base = &http.Client{Timeout: t.TotalTimeout}
	} else {
		base = &http.Client{CheckRedirect: base.CheckRedirect, Jar: base.Jar, Timeout: base.Timeout}
	}
	base.Transport = transport
	if t.OutboundPolicy != nil {
		base = t.OutboundPolicy.Client(base.Transport)
	}
	return base, nil
}
func (t *HTTPTransport) client() *http.Client {
	t.clientOnce.Do(func() {
		client := t.Client
		if client == nil {
			base := http.DefaultTransport.(*http.Transport).Clone()
			if t.ConnectTimeout > 0 {
				base.DialContext = (&net.Dialer{Timeout: t.ConnectTimeout}).DialContext
				base.TLSHandshakeTimeout = t.ConnectTimeout
			}
			if t.FirstByteTimeout > 0 {
				base.ResponseHeaderTimeout = t.FirstByteTimeout
			}
			if t.IdleTimeout > 0 {
				base.IdleConnTimeout = t.IdleTimeout
			}
			client = &http.Client{Transport: base, Timeout: t.TotalTimeout}
		}
		if t.OutboundPolicy != nil {
			if t.OutboundPolicy.RequestTimeout <= 0 {
				t.OutboundPolicy.RequestTimeout = t.TotalTimeout
			}
			client = t.OutboundPolicy.Client(client.Transport)
		}
		t.configuredClient = client
	})
	return t.configuredClient
}

func (t *HTTPTransport) withTotalTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if t.TotalTimeout > 0 {
		return context.WithTimeout(ctx, t.TotalTimeout)
	}
	return ctx, func() {}
}
func (t *HTTPTransport) newRequest(ctx context.Context, built providers.BuiltRequest, endpoint, accept string) (*http.Request, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	query := u.Query()
	for key, value := range built.Auth.Query {
		query.Set(key, value)
	}
	u.RawQuery = query.Encode()
	if t.OutboundPolicy != nil {
		if _, err := t.OutboundPolicy.Validate(ctx, u.String()); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, built.Endpoint.Method, u.String(), bytes.NewReader(built.Body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)
	for key, values := range built.Auth.Headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if built.Auth.Cookie != "" {
		req.Header.Set("Cookie", built.Auth.Cookie)
	}
	return req, nil
}
func (t *HTTPTransport) maxBytes() int64 {
	if t.MaxResponseBytes > 0 {
		return t.MaxResponseBytes
	}
	return DefaultMaxResponseBytes
}
func (t *HTTPTransport) maxSSEEventBytes() int {
	limit := t.MaxSSEEventBytes
	if limit <= 0 {
		limit = DefaultMaxSSEEventBytes
	}
	if responseLimit := t.maxBytes(); responseLimit < int64(limit) {
		limit = int(responseLimit)
	}
	return limit
}
func (t *HTTPTransport) maxSSELineBytes() int {
	limit := t.MaxSSELineBytes
	if limit <= 0 {
		limit = DefaultMaxSSELineBytes
	}
	if eventLimit := t.maxSSEEventBytes(); limit > eventLimit {
		limit = eventLimit
	}
	return limit
}
func (t *HTTPTransport) endpoint(providerID string, e providers.Endpoint) (string, error) {
	base := strings.TrimRight(t.BaseURLs[providerID], "/")
	if base == "" {
		return "", fmt.Errorf("transport: no base URL for provider %q", providerID)
	}
	u, err := url.Parse(base + "/" + strings.TrimLeft(e.Path, "/"))
	if err != nil {
		return "", err
	}
	q := u.Query()
	for k, v := range e.Query {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func providerFor(acct proxy.Account, req contracts.Request) string {
	if acct.Provider != "" {
		return acct.Provider
	}
	switch req.Protocol {
	case contracts.SurfaceAnthropic:
		return "anthropic"
	case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses, contracts.SurfaceImages:
		return "openai"
	default:
		return "default"
	}
}
func categoryError(c providers.ResponseCategory) contracts.ErrorKind {
	switch c {
	case providers.CategorySuccess:
		return contracts.ErrorFatal
	case providers.CategoryAuth:
		return contracts.ErrorAuthentication
	case providers.CategoryEntitlement:
		return contracts.ErrorEntitlement
	case providers.CategoryRateLimit:
		return contracts.ErrorRateLimit
	case providers.CategoryQuota:
		return contracts.ErrorQuota
	case providers.CategoryCapacity:
		return contracts.ErrorCapacity
	case providers.CategoryContentPolicy:
		return contracts.ErrorContentPolicy
	case providers.CategoryEmptyOutput:
		return contracts.ErrorEmptyOutput
	case providers.CategoryInvalidRequest:
		return contracts.ErrorInvalidRequest
	case providers.CategoryTransient:
		return contracts.ErrorTransient
	case providers.CategoryServerError:
		return contracts.ErrorServerError
	case providers.CategoryFatal:
		return contracts.ErrorFatal
	default:
		return contracts.ErrorFatal
	}
}

func classifiedRouteError(ctx context.Context, providerID, model string, classified providers.ClassifiedResponse) *contracts.RouteError {
	retryAfter := classified.RetryAfter
	if retryAfter < 0 {
		retryAfter = 0
	}
	if deadline, ok := ctx.Deadline(); ok && retryAfter > 0 {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			retryAfter = 0
		} else if retryAfter > remaining {
			retryAfter = remaining
		}
	}
	source := contracts.RateSource("")
	switch classified.Category {
	case providers.CategoryRateLimit:
		source = contracts.RateSourceProviderRate
	case providers.CategoryQuota:
		source = contracts.RateSourceProviderQuota
	}
	return &contracts.RouteError{
		Kind: categoryError(classified.Category), StatusCode: classified.StatusCode,
		Provider: providerID, Model: model, Code: classified.Code, Message: classified.Message,
		Retryable: classified.Retryable, RetryAfterMS: retryAfter.Milliseconds(),
		AlternateAccountEligible: classified.AlternateAccountEligible,
		RateSource:               source, RateScope: classified.Scope, RatePhase: classified.Phase,
		Scope: classified.Scope, Phase: classified.Phase,
	}
}

func setupRouteError(ctx context.Context, kind contracts.ErrorKind, providerID, model, code, message string, retryable, alternate bool, scope contracts.RateScope, phase contracts.RatePhase) *contracts.RouteError {
	var boundedCause error
	if ctx != nil {
		switch {
		case errors.Is(ctx.Err(), context.Canceled):
			boundedCause = context.Canceled
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			boundedCause = context.DeadlineExceeded
		}
	}
	return &contracts.RouteError{
		Kind: kind, Provider: providerID, Model: model, Code: code, Message: message,
		Retryable: retryable, AlternateAccountEligible: alternate,
		RateScope: scope, RatePhase: phase, Scope: scope, Phase: phase, Err: boundedCause,
	}
}

func transportRouteError(ctx context.Context, providerID, model string, throughProxy bool, message string, cause error) *contracts.RouteError {
	scope := contracts.RateScopeProvider
	code := "provider.transport_failed"
	if throughProxy {
		scope = contracts.RateScopeProxy
		code = "proxy.transport_failed"
	}
	var boundedCause error
	switch {
	case errors.Is(cause, context.Canceled):
		boundedCause = context.Canceled
	case errors.Is(cause, context.DeadlineExceeded), errors.Is(ctx.Err(), context.DeadlineExceeded):
		boundedCause = context.DeadlineExceeded
	}
	return &contracts.RouteError{
		Kind: contracts.ErrorTransient, Provider: providerID, Model: model,
		Code: code, Message: message, Retryable: true, AlternateAccountEligible: true,
		RateScope: scope, RatePhase: contracts.RatePhaseProvider,
		Scope: scope, Phase: contracts.RatePhaseProvider, Err: boundedCause,
	}
}

var _ proxy.Transport = (*HTTPTransport)(nil)
var _ proxy.StreamTransport = (*HTTPTransport)(nil)
