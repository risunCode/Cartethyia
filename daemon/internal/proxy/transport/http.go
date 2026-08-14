package transport

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
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
	URL     *url.URL
	ID      string
	Release func()
}

type ProxySelector func(context.Context, string, string) (ProxySelection, error)
type ProxyFailureRecorder func(context.Context, string, string, string)

type HTTPTransport struct {
	Registry          *providers.Registry
	Client            *http.Client
	ProxySelector     ProxySelector
	ProxyFailure      ProxyFailureRecorder
	BaseURLs          map[string]string
	ResolveCredential CredentialResolver
	OutboundPolicy    *outbound.Policy
	MaxResponseBytes  int64
	ConnectTimeout    time.Duration
	FirstByteTimeout  time.Duration
	TotalTimeout      time.Duration
	IdleTimeout       time.Duration
	clientOnce        sync.Once
	configuredClient  *http.Client
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
		return nil, &contracts.RouteError{Kind: contracts.ErrorFatal, Provider: providerID, Message: "provider unavailable", Err: err}
	}
	surface := req.Protocol
	if (providerID == "openai" || providerID == "codex") && surface == providers.SurfaceOpenAIChat {
		surface = providers.SurfaceOpenAIResponses
	}
	target, err := p.ResolveTarget(req.Model, surface)
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorInvalidRequest, Provider: providerID, Message: "model or surface unsupported", Err: err}
	}
	credential, err := t.resolve(requestCtx, acct.CredentialRef.String())
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorAuthentication, Provider: providerID, Message: "credential unavailable", Err: err}
	}
	built, err := p.BuildRequest(providers.RequestEnvelope{Target: target, Body: req.Body, Stream: req.Stream, Headers: req.Headers}, credential)
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorInvalidRequest, Provider: providerID, Message: "provider request invalid", Err: err}
	}
	selection, err := t.selectProxy(requestCtx, providerID, acct.ID)
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "proxy selection failed", Err: err}
	}
	if selection.Release == nil {
		selection.Release = func() {}
	}
	defer selection.Release()
	client, err := t.clientForProxy(selection.URL)
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "proxy transport unavailable", Err: err}
	}
	for attempt := 0; attempt < 2; attempt++ {
		endpoint, err := t.endpoint(providerID, built.Endpoint)
		if err != nil {
			return nil, err
		}
		httpReq, err := t.newRequest(requestCtx, built, endpoint, "application/json")
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(httpReq)
		if err != nil {
			t.recordProxyFailure(requestCtx, selection.ID, "transport", err.Error())
			return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "provider transport failed", Err: err}
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, t.maxBytes()+1))
		resp.Body.Close()
		if readErr != nil {
			return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "provider response read failed", Err: readErr}
		}
		if int64(len(body)) > t.maxBytes() {
			return nil, &contracts.RouteError{Kind: contracts.ErrorFatal, Provider: providerID, Message: "provider response exceeded bound"}
		}
		classified := p.ClassifyResponse(resp.StatusCode, body)
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return &contracts.Response{StatusCode: resp.StatusCode, Headers: resp.Header.Clone(), Body: body}, nil
		}
		if attempt == 0 && strings.EqualFold(providerID, "grok-build") && isInvalidEncryptedContentPayload(body) {
			if sanitized, changed := stripGrokEncryptedReasoning(built.Body); changed {
				built.Body = sanitized
				continue
			}
		}
		return nil, &contracts.RouteError{Kind: categoryError(classified.Category), StatusCode: resp.StatusCode, Provider: providerID, Message: classified.Message}
	}
	return nil, &contracts.RouteError{Kind: contracts.ErrorInvalidRequest, Provider: providerID, Message: "provider encrypted-content retry exhausted"}
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
		return nil, err
	}
	surface := req.Protocol
	if (providerID == "openai" || providerID == "codex") && surface == providers.SurfaceOpenAIChat {
		surface = providers.SurfaceOpenAIResponses
	}
	target, err := p.ResolveTarget(req.Model, surface)
	if err != nil {
		return nil, err
	}
	credential, err := t.resolve(requestCtx, acct.CredentialRef.String())
	if err != nil {
		return nil, err
	}
	built, err := p.BuildRequest(providers.RequestEnvelope{Target: target, Body: req.Body, Stream: true, Headers: req.Headers}, credential)
	if err != nil {
		return nil, err
	}
	selection, err := t.selectProxy(requestCtx, providerID, acct.ID)
	if err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "proxy selection failed", Err: err}
	}
	if selection.Release == nil {
		selection.Release = func() {}
	}
	client, err := t.clientForProxy(selection.URL)
	if err != nil {
		selection.Release()
		return nil, &contracts.RouteError{Kind: contracts.ErrorTransient, Provider: providerID, Message: "proxy transport unavailable", Err: err}
	}
	endpoint, err := t.endpoint(providerID, built.Endpoint)
	if err != nil {
		selection.Release()
		return nil, err
	}
	streamCtx, cancel := context.WithCancel(requestCtx)
	cancelAll := func() {
		selection.Release()
		cancel()
		totalCancel()
	}
	httpReq, err := t.newRequest(streamCtx, built, endpoint, "text/event-stream")
	if err != nil {
		cancelAll()
		return nil, err
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		t.recordProxyFailure(requestCtx, selection.ID, "transport", err.Error())
		cancelAll()
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, t.maxBytes()))
		resp.Body.Close()
		cancelAll()
		classified := p.ClassifyResponse(resp.StatusCode, body)
		return nil, &contracts.RouteError{Kind: categoryError(classified.Category), StatusCode: resp.StatusCode, Provider: providerID, Message: classified.Message}
	}
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
		scan := bufio.NewScanner(resp.Body)
		scan.Buffer(make([]byte, 4096), int(t.maxBytes()))
		for scan.Scan() {
			line := scan.Bytes()
			if !bytes.HasPrefix(line, []byte("data:")) {
				continue
			}
			payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
			if string(payload) == "[DONE]" {
				_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop})
				return
			}
			if strings.EqualFold(providerID, "grok-build") && isInvalidEncryptedContentPayload(payload) {
				_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop, Err: proxy.ErrInvalidEncryptedContent, Reason: "error"})
				return
			}
			if !send(proxy.StreamEvent{Kind: proxy.EventTextDelta, Payload: append([]byte(nil), payload...)}) {
				return
			}
		}
		if err := scan.Err(); err != nil {
			_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop, Reason: err.Error()})
			return
		}
		_ = send(proxy.StreamEvent{Kind: proxy.EventMessageStop})
	}()
	streamStarted = true
	return s, nil
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
func stripGrokEncryptedReasoning(body []byte) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, false
	}
	items, ok := payload["input"].([]any)
	if !ok {
		return nil, false
	}
	changed := false
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := item["type"].(string)
		if kind != "reasoning" && kind != "compaction" && kind != "compaction_summary" {
			continue
		}
		if _, exists := item["encrypted_content"]; exists {
			delete(item, "encrypted_content")
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	payload["input"] = items
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	return encoded, true
}
func isInvalidEncryptedContentPayload(payload []byte) bool {
	lower := strings.ToLower(string(payload))
	return strings.Contains(lower, "invalid_encrypted_content") ||
		(strings.Contains(lower, "encrypted_content") &&
			(strings.Contains(lower, "decrypt") || strings.Contains(lower, "unmodified") || strings.Contains(lower, "invalid")))
}
func (t *HTTPTransport) maxBytes() int64 {
	if t.MaxResponseBytes > 0 {
		return t.MaxResponseBytes
	}
	return DefaultMaxResponseBytes
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
	if req.Headers != nil {
		if value := req.Headers.Get("X-Cartethyia-Provider"); value != "" {
			return value
		}
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
	case providers.CategoryAuth:
		return contracts.ErrorAuthentication
	case providers.CategoryRateLimit:
		return contracts.ErrorRateLimit
	case providers.CategoryQuota:
		return contracts.ErrorQuota
	case providers.CategoryInvalidRequest:
		return contracts.ErrorInvalidRequest
	case providers.CategoryTransient:
		return contracts.ErrorTransient
	default:
		return contracts.ErrorFatal
	}
}

var _ proxy.Transport = (*HTTPTransport)(nil)
var _ proxy.StreamTransport = (*HTTPTransport)(nil)
