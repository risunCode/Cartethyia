package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/compression"
	"github.com/cartethyia/daemon/internal/proxy/control/admission"
	"github.com/cartethyia/daemon/internal/proxy/control/continuation"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
)

// DispatchService owns request-level validation, admission, continuation
// scope, and the canonical result boundary. Router remains the owner of
// candidate selection and bounded failover.
type DispatchService struct {
	Router          *Router
	Transport       Transport
	StreamTransport StreamTransport
	Continuations   *continuation.Store
	Admission       *admission.Limiter
	Metadata        MetadataWriter
	Catalog         *catalog.Snapshot
	Usage           *usage.Ledger
	Now             func() time.Time
}

// defaultTokenSaver is local and deterministic. It is deliberately fail-open
// and does not depend on a durable cache, so development startup remains
// independent of PostgreSQL while supported requests still exercise the RTK
// implementation.
var defaultTokenSaver = compression.NewOrchestrator()

// MetadataWriter is the non-blocking request-history enqueue boundary. A
// writer failure must never become a request-path failure.
type MetadataWriter interface {
	Enqueue(observability.Metadata) error
}

// DispatchError carries a stable proxy-owned code while retaining the public
// RouteError for the existing HTTP error mapper.
type DispatchError struct {
	Code string
	Err  *contracts.RouteError
}

func (e *DispatchError) Error() string {
	if e == nil {
		return ""
	}
	if e.Err == nil {
		return e.Code
	}
	if e.Code == "" {
		return e.Err.Message
	}
	return e.Code + ": " + e.Err.Message
}
func (e *DispatchError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}
func (e *DispatchError) CodeString() string {
	if e == nil {
		return ""
	}
	return e.Code
}

// DispatchCodeOf returns the stable proxy code carried by a dispatch error.
func DispatchCodeOf(err error) string {
	var coded *DispatchError
	if errors.As(err, &coded) && coded != nil {
		return coded.Code
	}
	return ""
}

const (
	codeDispatchInvalidRequest = "proxy.invalid_request"
	codeDispatchAdmission      = "proxy.admission"
	codeDispatchCatalog        = "proxy.catalog"
	codeDispatchCanceled       = "proxy.canceled"
	codeDispatchDeadline       = "proxy.deadline"
	codeDispatchProvider       = "proxy.provider_failure"
	codeDispatchMalformed      = "proxy.malformed_provider_response"
	codeDispatchNoRoute        = "proxy.no_usable_account"
	codeDispatchUsage          = "proxy.usage"
	codeDispatchInternal       = "proxy.internal"
)

func (s *DispatchService) Dispatch(req *contracts.Request) (apicontracts.Stream, error) {
	return s.DispatchContext(context.Background(), req)
}

// DispatchContext is the cancellable form used by lifecycle callers and
// tests; Dispatch is retained for the historical server interface.
func (s *DispatchService) DispatchContext(ctx context.Context, req *contracts.Request) (result apicontracts.Stream, retErr error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s == nil || s.Router == nil || s.Transport == nil {
		return nil, dispatchError(codeDispatchInternal, contracts.ErrorFatal, http.StatusInternalServerError, "dispatch service is not configured", nil)
	}
	normalized, err := s.validateRequest(ctx, req)
	if err != nil {
		return nil, err
	}
	req = normalized
	meta := requestMetadata(*req)
	deferMetadata := true
	defer func() {
		if !deferMetadata {
			return
		}
		if retErr != nil {
			meta.Outcome = metadataOutcome(retErr)
			meta.Cancelled = errors.Is(retErr, context.Canceled)
		}
		meta.EndedAt = time.Now().UTC()
		meta.LatencyMS = meta.EndedAt.Sub(meta.StartedAt).Milliseconds()
		if s.Metadata != nil {
			_ = s.Metadata.Enqueue(meta)
		}
	}()
	if err := s.resolveCatalog(req); err != nil {
		return nil, err
	}
	if err := s.validateContinuation(ctx, *req); err != nil {
		return nil, err
	}

	var lease *admission.Lease
	if s.Admission != nil {
		var acquireErr error
		lease, acquireErr = s.Admission.Acquire(ctx, admissionKeys(*req))
		if acquireErr != nil {
			code := codeDispatchAdmission
			status := http.StatusTooManyRequests
			kind := contracts.ErrorRateLimit
			if errors.Is(acquireErr, context.Canceled) {
				code, status, kind = codeDispatchCanceled, http.StatusBadRequest, contracts.ErrorTransient
			} else if errors.Is(acquireErr, context.DeadlineExceeded) {
				code, status, kind = codeDispatchDeadline, http.StatusGatewayTimeout, contracts.ErrorTransient
			}
			return nil, dispatchError(code, kind, status, "request admission failed", acquireErr)
		}
		defer lease.Release()
	}

	if req.Stream {
		if s.StreamTransport == nil {
			return nil, dispatchError(codeDispatchProvider, contracts.ErrorFatal, http.StatusNotImplemented, "streaming transport is not configured", nil)
		}
		stream, _, failure, routeErr := s.Router.RouteStream(ctx, s.StreamTransport, *req)
		if routeErr != nil {
			return nil, dispatchRouterError(routeErr)
		}
		if failure != nil {
			return nil, dispatchFailureError(failure)
		}
		if stream == nil {
			return nil, dispatchError(codeDispatchMalformed, contracts.ErrorFatal, http.StatusBadGateway, "provider returned no stream", nil)
		}
		deferMetadata = false
		streamMeta := meta
		return &streamResponse{
			status: http.StatusOK, contentType: "text/event-stream",
			headers: http.Header{"Cache-Control": []string{"no-cache"}},
			stream:  stream, surface: req.Protocol, model: req.Model,
			finalize: func(streamErr error) {
				if streamErr != nil {
					streamMeta.Outcome = metadataOutcome(streamErr)
					streamMeta.Cancelled = errors.Is(streamErr, context.Canceled)
				}
				streamMeta.EndedAt = time.Now().UTC()
				streamMeta.LatencyMS = streamMeta.EndedAt.Sub(streamMeta.StartedAt).Milliseconds()
				if s.Metadata != nil {
					_ = s.Metadata.Enqueue(streamMeta)
				}
			},
		}, nil
	}

	response, failure, routeErr := s.Router.Route(ctx, validatingTransport{next: s.Transport}, *req)
	if routeErr != nil {
		return nil, dispatchRouterError(routeErr)
	}
	if err := ctx.Err(); err != nil {
		return nil, dispatchContextError(err)
	}
	if failure != nil {
		return nil, dispatchFailureError(failure)
	}
	if err := validateProviderResponse(response); err != nil {
		return nil, dispatchError(codeDispatchMalformed, contracts.ErrorFatal, http.StatusBadGateway, "provider returned malformed response", err)
	}
	response = projectNativeResponsesToChat(*req, response)
	applyResponseMetadata(&meta, response.Body)
	if err := s.recordUsage(*req, response); err != nil {
		return nil, err
	}
	if err := s.recordContinuation(ctx, *req, response.Body); err != nil {
		return nil, err
	}
	return &bufferResponse{status: response.StatusCode, contentType: response.Headers.Get("Content-Type"), headers: response.Headers, body: response.Body}, nil
}

func (s *DispatchService) validateRequest(ctx context.Context, req *contracts.Request) (*contracts.Request, error) {
	if req == nil {
		return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request is required", nil)
	}
	copyReq := *req
	if req.Headers == nil {
		copyReq.Headers = make(http.Header)
	} else {
		copyReq.Headers = req.Headers.Clone()
	}
	copyReq.Body = bytes.Clone(req.Body)
	if !copyReq.Protocol.IsValid() {
		return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "unsupported request surface", nil)
	}
	if len(copyReq.Body) == 0 || len(copyReq.Body) > contracts.MaxRequestBodyBytes {
		return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request body is invalid", nil)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(copyReq.Body, &payload); err != nil || payload == nil {
		return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request body is malformed", err)
	}
	if copyReq.Protocol == contracts.ProtocolOpenAIChat || copyReq.Protocol == contracts.ProtocolOpenAIResponse || copyReq.Protocol == contracts.ProtocolAnthropic {
		prepared, transformErr := transforms.NormalizeRequest(ctx, copyReq.Protocol, copyReq.Body, copyReq.Stream)
		if transformErr != nil {
			return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request normalization failed", transformErr)
		}
		copyReq.Body = prepared.Body
		if copyReq.Model == "" {
			copyReq.Model = prepared.Request.Model
		}
		if saverReq, changed := applyTokenSaver(ctx, prepared.Request); changed {
			body, encodeErr := transforms.EncodeNormalizedRequest(ctx, copyReq.Protocol, saverReq, copyReq.Body)
			if encodeErr != nil {
				return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request token preparation failed", encodeErr)
			}
			copyReq.Body = body
		}
	}
	if copyReq.Model == "" {
		copyReq.Model = modelFromBody(copyReq.Body)
	}
	if copyReq.Model == "" || len(copyReq.Model) > contracts.MaxIdentifierBytes {
		return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "model is required", nil)
	}
	return &copyReq, nil
}

// applyTokenSaver adapts the canonical request to the compression package's
// deliberately small view. Only tool-result text can change; every other
// canonical field remains untouched.
func applyTokenSaver(ctx context.Context, req *transforms.NormalizedRequest) (*transforms.NormalizedRequest, bool) {
	if req == nil {
		return nil, false
	}
	view := compression.Request{Model: req.Model, Messages: make([]compression.Message, len(req.Messages))}
	for mi, message := range req.Messages {
		view.Messages[mi] = compression.Message{Role: string(message.Role), Content: make([]compression.Block, len(message.Content))}
		for bi, block := range message.Content {
			kind := compression.BlockOther
			if block.Type == transforms.BlockToolResult {
				kind = compression.BlockToolResult
			}
			view.Messages[mi].Content[bi] = compression.Block{
				Kind: kind, Text: block.Text, ToolResultIsErr: block.ToolResultIsError,
				ToolName: block.ToolName, ToolCallID: block.ToolCallID, IsUserAuthored: message.Role == transforms.RoleUser,
			}
		}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	outcome := defaultTokenSaver.Run(ctx, view)
	if !outcome.TokenSummary.HasShrunk() {
		return req, false
	}
	out := cloneNormalizedRequestForRuntime(req)
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			if out.Messages[mi].Content[bi].Type == transforms.BlockToolResult {
				out.Messages[mi].Content[bi].Text = outcome.Request.Messages[mi].Content[bi].Text
			}
		}
	}
	return out, true
}

func cloneNormalizedRequestForRuntime(req *transforms.NormalizedRequest) *transforms.NormalizedRequest {
	out := *req
	out.Messages = append([]transforms.NormalizedMessage(nil), req.Messages...)
	for i := range out.Messages {
		out.Messages[i].Content = append([]transforms.ContentBlock(nil), req.Messages[i].Content...)
	}
	return &out
}

func (s *DispatchService) resolveCatalog(req *contracts.Request) error {
	if s.Catalog == nil {
		return nil
	}
	model, err := s.Catalog.Resolve(req.Model)
	if err != nil {
		return dispatchError(codeDispatchCatalog, contracts.ErrorInvalidRequest, http.StatusBadRequest, "requested model is unavailable", err)
	}
	if len(model.Surfaces) > 0 {
		supported := false
		for _, surface := range model.Surfaces {
			if string(surface) == string(req.Protocol) {
				supported = true
				break
			}
		}
		if !supported {
			return dispatchError(codeDispatchCatalog, contracts.ErrorInvalidRequest, http.StatusBadRequest, "requested surface is unsupported for model", nil)
		}
	}
	req.Model = model.ID
	if model.ProviderID != "" && req.Headers.Get("X-Cartethyia-Provider") == "" {
		req.Headers.Set("X-Cartethyia-Provider", model.ProviderID)
	}
	return nil
}

func admissionKeys(req contracts.Request) map[string]string {
	keys := map[string]string{"global": "global"}
	if req.Stream {
		keys["stream"] = "stream"
	}
	if req.Headers != nil {
		identity := headerValue(req.Headers, "Authorization") + "\x00" + headerValue(req.Headers, "X-API-Key")
		if identity != "\x00" {
			sum := sha256.Sum256([]byte(identity))
			keys["api_key"] = hex.EncodeToString(sum[:])
		}
	}
	return keys
}

func headerValue(headers http.Header, key string) string {
	if headers == nil {
		return ""
	}
	if value := headers.Get(key); value != "" {
		return value
	}
	for name, values := range headers {
		if strings.EqualFold(name, key) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func dispatchError(code string, kind contracts.ErrorKind, status int, message string, cause error) error {
	return &DispatchError{Code: code, Err: &contracts.RouteError{
		Kind: kind, StatusCode: status, Message: message, Err: cause,
	}}
}

func dispatchContextError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return dispatchError(codeDispatchDeadline, contracts.ErrorTransient, http.StatusGatewayTimeout, "request deadline exceeded", err)
	}
	if errors.Is(err, context.Canceled) {
		return dispatchError(codeDispatchCanceled, contracts.ErrorTransient, http.StatusBadRequest, "request canceled", err)
	}
	return dispatchError(codeDispatchProvider, contracts.ErrorTransient, http.StatusBadGateway, "proxy execution failed", err)
}

func dispatchFailureError(failure *Failure) error {
	if failure == nil {
		return dispatchError(codeDispatchProvider, contracts.ErrorFatal, http.StatusBadGateway, "provider failed", nil)
	}
	kind := contracts.ErrorFatal
	status := failure.StatusCode
	code := codeDispatchProvider
	switch failure.Kind {
	case FailureInvalidRequest:
		kind, status, code = contracts.ErrorInvalidRequest, http.StatusBadRequest, codeDispatchInvalidRequest
	case FailureAuthentication:
		kind, code = contracts.ErrorAuthentication, codeDispatchProvider
		if status == 0 {
			status = http.StatusBadGateway
		}
	case FailureRateLimit:
		kind, code = contracts.ErrorRateLimit, codeDispatchProvider
		if status == 0 {
			status = http.StatusTooManyRequests
		}
	case FailureQuota:
		kind, code = contracts.ErrorQuota, codeDispatchProvider
		if status == 0 {
			status = http.StatusTooManyRequests
		}
	case FailureTransient:
		kind, code = contracts.ErrorTransient, codeDispatchProvider
	case FailureAborted:
		return dispatchContextError(failure.Err)
	case FailureUnknown:
		code = codeDispatchNoRoute
	}
	if status < 400 {
		status = http.StatusBadGateway
	}
	message := failure.Message
	if message == "" {
		message = "provider request failed"
	}
	return dispatchError(code, kind, status, message, failure.Err)
}

func dispatchRouterError(err error) error {
	if errors.Is(err, ErrNoAccount) {
		return dispatchError(codeDispatchNoRoute, contracts.ErrorTransient, http.StatusServiceUnavailable, "no usable provider account", err)
	}
	return dispatchContextError(err)
}

func validateProviderResponse(response *contracts.Response) error {
	if response == nil {
		return errors.New("provider response is nil")
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("provider response status %d is not successful", response.StatusCode)
	}
	if len(response.Body) == 0 || !json.Valid(response.Body) {
		return errors.New("provider response body is not valid JSON")
	}
	return nil
}

type validatingTransport struct{ next Transport }

func (t validatingTransport) Call(ctx context.Context, acct Account, req contracts.Request) (*contracts.Response, error) {
	if t.next == nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorFatal, StatusCode: http.StatusInternalServerError, Message: "provider transport is unavailable"}
	}
	response, err := t.next.Call(ctx, acct, req)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorFatal, StatusCode: http.StatusBadGateway, Provider: acct.Provider, Message: "provider response is nil"}
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		classified := Classify(ClassifyInput{StatusCode: response.StatusCode})
		return nil, &contracts.RouteError{
			Kind: contractKind(classified.Kind), StatusCode: response.StatusCode,
			Provider: acct.Provider, Message: "provider returned unsuccessful status",
		}
	}
	if err := validateProviderResponse(response); err != nil {
		return nil, &contracts.RouteError{Kind: contracts.ErrorFatal, StatusCode: http.StatusBadGateway, Provider: acct.Provider, Message: "provider response is malformed", Err: err}
	}
	return response, nil
}

func contractKind(kind FailureKind) contracts.ErrorKind {
	switch kind {
	case FailureInvalidRequest:
		return contracts.ErrorInvalidRequest
	case FailureAuthentication:
		return contracts.ErrorAuthentication
	case FailureRateLimit:
		return contracts.ErrorRateLimit
	case FailureQuota:
		return contracts.ErrorQuota
	case FailureTransient:
		return contracts.ErrorTransient
	default:
		return contracts.ErrorFatal
	}
}
func (s *DispatchService) recordUsage(req contracts.Request, response *contracts.Response) error {
	if s.Usage == nil {
		return nil
	}
	requestID := headerValue(req.Headers, "X-Request-ID")
	if requestID == "" {
		sum := sha256.Sum256(append([]byte(req.Model+":"), req.Body...))
		requestID = hex.EncodeToString(sum[:])
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	event := usage.Event{
		RequestID: requestID, Attempt: 1, Provider: headerValue(req.Headers, "X-Cartethyia-Provider"),
		Model: req.Model, StartedAt: now(), EndedAt: now(),
	}
	event.Tokens = parseUsage(response.Body)
	if err := s.Usage.Register(event); err != nil && !errors.Is(err, usage.ErrDuplicate) {
		return dispatchError(codeDispatchUsage, contracts.ErrorFatal, http.StatusInternalServerError, "usage event could not be recorded", err)
	}
	return nil
}

func parseUsage(body []byte) usage.Tokens {
	var payload struct {
		Usage struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			Total      int64 `json:"total_tokens"`
			Prompt     int64 `json:"prompt_tokens"`
			Completion int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return usage.Tokens{}
	}
	input, output := payload.Usage.Input, payload.Usage.Output
	if input == 0 {
		input = payload.Usage.Prompt
	}
	if output == 0 {
		output = payload.Usage.Completion
	}
	total := payload.Usage.Total
	if total == 0 && (input != 0 || output != 0) {
		total = input + output
	}
	return usage.Tokens{
		Input: int64Ptr(input), Output: int64Ptr(output), Total: int64Ptr(total),
	}
}

func int64Ptr(value int64) *int64 {
	if value == 0 {
		return nil
	}
	return &value
}

func modelFromBody(body []byte) string {
	var payload struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return payload.Model
}
func (s *DispatchService) validateContinuation(ctx context.Context, req contracts.Request) error {
	if req.Protocol != contracts.ProtocolOpenAIResponse || s.Continuations == nil {
		return nil
	}
	var payload struct {
		PreviousResponseID string `json:"previous_response_id"`
	}
	if err := json.Unmarshal(req.Body, &payload); err != nil {
		return dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "invalid responses payload", err)
	}
	if payload.PreviousResponseID == "" {
		return nil
	}
	binding, err := continuationBinding(req)
	if err != nil {
		return dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "continuation is unavailable", err)
	}
	if _, err := s.Continuations.ResolveFor(ctx, payload.PreviousResponseID, binding); err != nil {
		return dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "continuation is unavailable", err)
	}
	return nil
}

func (s *DispatchService) recordContinuation(ctx context.Context, req contracts.Request, body []byte) error {
	if req.Protocol != contracts.ProtocolOpenAIResponse || s.Continuations == nil {
		return nil
	}
	var payload struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.ID == "" {
		return nil
	}
	if req.Headers == nil || req.Headers.Get("X-Cartethyia-Continuation-Scope") == "" {
		return nil
	}
	binding, err := continuationBinding(req)
	if err != nil {
		return dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "continuation is unavailable", err)
	}
	if err := s.Continuations.Put(ctx, continuation.State{
		ID: payload.ID, ResponseID: payload.ID, Scope: binding.Scope,
		Provider: binding.Provider, Model: binding.Model, Generation: binding.Generation,
	}); err != nil {
		return dispatchError(codeDispatchProvider, contracts.ErrorFatal, http.StatusInternalServerError, "continuation could not be recorded", err)
	}
	return nil
}

func continuationBinding(req contracts.Request) (continuation.Binding, error) {
	scope := ""
	provider := ""
	generation := uint64(0)
	if req.Headers != nil {
		scope = req.Headers.Get("X-Cartethyia-Continuation-Scope")
		provider = req.Headers.Get("X-Cartethyia-Provider")
		rawGeneration := req.Headers.Get("X-Cartethyia-Catalog-Generation")
		if rawGeneration != "" {
			parsed, err := strconv.ParseUint(rawGeneration, 10, 64)
			if err != nil {
				return continuation.Binding{}, &continuation.Error{
					Code: continuation.CodeInvalid, Op: "binding",
					Message: "continuation catalog generation is invalid", Err: err,
				}
			}
			generation = parsed
		}
	}
	if scope == "" {
		return continuation.Binding{}, continuation.ErrUnauthorized
	}
	if provider == "" {
		switch req.Protocol {
		case contracts.SurfaceAnthropic:
			provider = "anthropic"
		case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses, contracts.SurfaceImages:
			provider = "openai"
		default:
			provider = string(req.Protocol)
		}
	}
	if req.Model == "" {
		return continuation.Binding{}, &continuation.Error{
			Code: continuation.CodeInvalid, Op: "binding", Message: "continuation model is required",
		}
	}
	return continuation.Binding{Scope: scope, Provider: provider, Model: req.Model, Generation: generation}, nil
}

func continuationRouteError(err error) error {
	return &contracts.RouteError{
		Kind: contracts.ErrorInvalidRequest, StatusCode: http.StatusBadRequest,
		Message: "continuation is unavailable", Err: err,
	}
}

type bufferResponse struct {
	status      int
	contentType string
	headers     http.Header
	body        []byte
}

func (r *bufferResponse) StatusCode() int      { return r.status }
func (r *bufferResponse) ContentType() string  { return r.contentType }
func (r *bufferResponse) Headers() http.Header { return r.headers.Clone() }
func (r *bufferResponse) Body() apicontracts.StreamReader {
	return io.NopCloser(bytes.NewReader(r.body))
}

type streamResponse struct {
	status      int
	contentType string
	headers     http.Header
	stream      *Stream
	surface     contracts.Surface
	model       string
	mu          sync.Mutex
	reader      *StreamBridge
	bodyReader  apicontracts.StreamReader
	finalize    func(error)
}

func (r *streamResponse) StatusCode() int      { return r.status }
func (r *streamResponse) ContentType() string  { return r.contentType }
func (r *streamResponse) Headers() http.Header { return r.headers.Clone() }
func (r *streamResponse) Body() apicontracts.StreamReader {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reader == nil {
		bridge := NewStreamBridge(r.stream, r.surface, r.model)
		r.reader = bridge
		if r.finalize != nil {
			r.bodyReader = &finalizingReader{reader: bridge, finalize: r.finalize}
			return r.bodyReader
		}
	}
	if r.bodyReader != nil {
		return r.bodyReader
	}
	return r.reader
}

type finalizingReader struct {
	reader   *StreamBridge
	finalize func(error)
	once     sync.Once
}

func (r *finalizingReader) Read(p []byte) (int, error) { return r.reader.Read(p) }
func (r *finalizingReader) ReadContext(ctx context.Context, p []byte) (int, error) {
	return r.reader.ReadContext(ctx, p)
}
func (r *finalizingReader) Close() error {
	err := r.reader.Close()
	r.once.Do(func() { r.finalize(err) })
	return err
}
func (r *finalizingReader) Abort(err error) {
	r.reader.Abort(err)
	r.once.Do(func() { r.finalize(err) })
}

var _ apicontracts.ProxyService = (*DispatchService)(nil)
