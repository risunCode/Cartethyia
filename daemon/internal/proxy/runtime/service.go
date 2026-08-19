package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/compression"
	"github.com/cartethyia/daemon/internal/proxy/control/admission"
	"github.com/cartethyia/daemon/internal/proxy/control/continuation"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/healing"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
	runtimecache "github.com/cartethyia/daemon/internal/runtime/cache"
	apicontracts "github.com/cartethyia/daemon/internal/server/apicontracts"
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
	Evidence        *observability.Registry
	Catalog         catalog.Resolver
	Usage           *usage.Ledger
	// Codecs is the canonical request/response registry. Cross-surface
	// responses require the registered target decoder and source encoder;
	// same-surface responses remain native passthrough.
	Codecs *transforms.Registry
	// ResponseCache is an opt-in complete non-stream cache. It is consulted
	// after request/catalog validation but before admission/account acquisition.
	ResponseCache       *runtimecache.ResponseCache
	ResponseCacheTenant func(context.Context, contracts.Request) string
	Now                 func() time.Time
	// InFlight is the optional bounded live-dispatch registry backing the
	// admin in-flight stream; nil disables per-request tracking entirely.
	InFlight        *InFlightRegistry
	sideEffectFails atomic.Uint64
}

// inFlightDispatchCounter disambiguates anonymous dispatches (no
// X-Request-ID header) in the bounded in-flight registry.
var inFlightDispatchCounter atomic.Uint64

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

// SideEffectFailureCount returns the number of fail-open metadata, usage, or
// continuation operations that could not be recorded. The count is bounded
// evidence only; side-effect errors never replace a provider success.
func (s *DispatchService) SideEffectFailureCount() uint64 {
	if s == nil {
		return 0
	}
	return s.sideEffectFails.Load()
}

func (s *DispatchService) recordSideEffectFailure() {
	if s != nil {
		s.sideEffectFails.Add(1)
		if s.Evidence != nil {
			s.Evidence.ObserveSideEffectFailure()
		}
	}
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
	codeDispatchTranslation    = "proxy.response_translation"
	codeDispatchMalformed      = "proxy.malformed_provider_response"
	codeDispatchNoRoute        = "proxy.no_usable_account"
	codeDispatchUsage          = "proxy.usage"
	codeDispatchInternal       = "proxy.internal"
)

// DispatchContext owns one cancellable request lifecycle from admission
// through the final response or stream terminal boundary.
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
		panicValue := recover()
		if !deferMetadata {
			if panicValue != nil {
				panic(panicValue)
			}
			return
		}
		if panicValue != nil {
			meta.Outcome = observability.OutcomeError
			completeMetadata(&meta, nil, false, time.Now())
		} else {
			completeMetadata(&meta, retErr, false, time.Now())
		}
		s.enqueueMetadata(meta)
		if panicValue != nil {
			panic(panicValue)
		}
	}()
	plan, err := s.resolveCatalog(ctx, req)
	if err != nil {
		if s.Evidence != nil {
			var capabilityErr *catalog.CapabilityError
			if errors.As(err, &capabilityErr) && capabilityErr != nil {
				s.Evidence.ObserveCapability(observability.CapabilityEvidence{Code: capabilityErr.Code, Operation: operationLabel(capabilityErr.Operation), Feature: string(capabilityErr.Feature)})
			}
		}
		return nil, err
	}
	s.observeRoutePlan(*req, plan)
	if err := s.validateContinuation(ctx, *req); err != nil {
		return nil, err
	}
	if cached, ok := s.responseCacheGet(ctx, *req, plan); ok {
		applyResponseMetadata(&meta, cached.Body)
		return &bufferResponse{status: cached.StatusCode, contentType: cached.Headers.Get("Content-Type"), headers: cached.Headers, body: cached.Body}, nil
	}

	var lease *admission.Lease
	defer func() {
		if lease != nil {
			lease.Release()
		}
	}()
	if s.Admission != nil {
		var acquireErr error
		admissionStarted := time.Now()
		lease, acquireErr = s.Admission.Acquire(ctx, admissionKeys(*req))
		if s.Evidence != nil {
			s.Evidence.ObserveAdmissionWait(time.Since(admissionStarted))
		}
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
	}

	// Bounded live-dispatch tracking for the admin in-flight stream. Buffered
	// dispatches release through the defer below; streams transfer the release
	// to the stream finalizer, mirroring the admission lease ownership.
	var inFlightID string
	if s.InFlight != nil {
		inFlightID = meta.RequestID
		if inFlightID == "" {
			inFlightID = fmt.Sprintf("dispatch-%d-%d", meta.StartedAt.UnixNano(), inFlightDispatchCounter.Add(1))
		}
		s.InFlight.Track(BoundedInFlightRecord{ID: inFlightID, Model: meta.Model, Surface: meta.Surface, StartedAt: meta.StartedAt})
		defer func() {
			if inFlightID != "" {
				s.InFlight.Release(inFlightID)
			}
		}()
	}

	if req.Stream {
		if s.StreamTransport == nil {
			return nil, dispatchError(codeDispatchProvider, contracts.ErrorFatal, http.StatusNotImplemented, "streaming transport is not configured", nil)
		}
		stream, _, failure, routeErr := s.Router.RouteStream(ctx, s.StreamTransport, *req, plan)
		if routeErr != nil {
			return nil, dispatchRouterError(routeErr)
		}
		if failure != nil {
			s.observeFailureExhaustion(failure)
			return nil, dispatchFailureError(failure)
		}
		if stream == nil {
			return nil, dispatchError(codeDispatchMalformed, contracts.ErrorFatal, http.StatusBadGateway, "provider returned no stream", nil)
		}
		streamMeta := meta
		trackedInFlight := inFlightID
		stream.AttachAdmissionLease(lease)
		stream.AttachFinalizer(func(streamErr, sideEffectErr error) {
			if sideEffectErr != nil {
				s.recordSideEffectFailure()
			}
			s.finalizeStream(ctx, *req, stream, &streamMeta, streamErr)
			if trackedInFlight != "" {
				s.InFlight.Release(trackedInFlight)
			}
		})
		lease = nil
		inFlightID = ""
		deferMetadata = false
		return &streamResponse{
			status: http.StatusOK, contentType: "text/event-stream",
			headers: http.Header{"Cache-Control": []string{"no-cache"}},
			stream:  stream, surface: req.Protocol, model: req.Model, codecs: s.Codecs,
		}, nil
	}

	response, failure, routeErr := s.Router.Route(ctx, validatingTransport{next: s.Transport}, *req, plan)
	if routeErr != nil {
		return nil, dispatchRouterError(routeErr)
	}
	if err := ctx.Err(); err != nil {
		return nil, dispatchContextError(err)
	}
	if failure != nil {
		s.observeFailureExhaustion(failure)
		return nil, dispatchFailureError(failure)
	}
	if err := validateProviderResponse(response); err != nil {
		return nil, dispatchError(codeDispatchMalformed, contracts.ErrorFatal, http.StatusBadGateway, "provider returned malformed response", err)
	}
	s.responseCacheSet(ctx, *req, plan, response)
	response, projectionErr := canonicalResponseProjection(*req, responseTargetSurface(*req, plan), response, s.Codecs)
	if projectionErr != nil {
		return nil, dispatchError(codeDispatchTranslation, contracts.ErrorTranslation, http.StatusBadGateway, "provider response could not be translated", projectionErr)
	}
	applyResponseMetadata(&meta, response.Body)
	s.recordDispatchSideEffects(ctx, *req, parseUsage(response.Body), responseContinuationID(response.Body))
	return &bufferResponse{status: response.StatusCode, contentType: response.Headers.Get("Content-Type"), headers: response.Headers, body: response.Body}, nil
}

func (s *DispatchService) responseCacheSpec(ctx context.Context, req contracts.Request, plan catalog.RoutePlan) (runtimecache.ResponseSpec, bool) {
	if s == nil || s.ResponseCache == nil || req.Stream || plan.Operation == transforms.OperationCompactV1 || plan.Operation == transforms.OperationCompactV2 || len(plan.Members) == 0 || req.ContinuationScope != "" {
		return runtimecache.ResponseSpec{}, false
	}
	tenant := req.ContinuationScope
	if s.ResponseCacheTenant != nil {
		tenant = s.ResponseCacheTenant(ctx, req)
	}
	if tenant == "" {
		return runtimecache.ResponseSpec{}, false
	}
	target := req.Protocol
	provider := ""
	model := req.Model
	if member := plan.Members[0]; member.TargetSurface != "" {
		target, provider, model = contracts.Surface(member.TargetSurface), member.ProviderID, member.ClientModelID
	} else {
		if member.ProviderID != "" {
			provider = member.ProviderID
		}
		if member.ClientModelID != "" {
			model = member.ClientModelID
		}
		if member.Surface != "" {
			target = member.Surface
		}
	}
	if provider == "" || model == "" {
		return runtimecache.ResponseSpec{}, false
	}
	digest := sha256.Sum256(req.Body)
	return runtimecache.ResponseSpec{TenantID: tenant, SourceSurface: string(req.Protocol), TargetSurface: string(target), Provider: provider, Model: model, RequestBodyDigest: fmt.Sprintf("%x", digest[:]), Generation: runtimecache.Generation{Catalog: plan.Generation, Health: 1, Network: 1}, Complete: true}, true
}

func (s *DispatchService) responseCacheGet(ctx context.Context, req contracts.Request, plan catalog.RoutePlan) (*contracts.Response, bool) {
	spec, ok := s.responseCacheSpec(ctx, req, plan)
	if !ok {
		return nil, false
	}
	entry, err := s.ResponseCache.Get(ctx, spec)
	if err != nil || len(entry.Value) == 0 {
		if s.Evidence != nil {
			s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: observability.CacheLookup, Outcome: "miss"})
		}
		return nil, false
	}
	response := &contracts.Response{StatusCode: http.StatusOK, Headers: http.Header{"Content-Type": []string{"application/json"}}, Body: entry.Value}
	if err := validateProviderResponse(response); err != nil {
		if s.Evidence != nil {
			s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: observability.CacheReject, Outcome: "rejected"})
		}
		return nil, false
	}
	projected, projectionErr := canonicalResponseProjection(req, responseTargetSurface(req, plan), response, s.Codecs)
	if projectionErr != nil {
		if s.Evidence != nil {
			s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: observability.CacheReject, Outcome: "rejected"})
		}
		return nil, false
	}
	response = projected
	if err := validateProviderResponse(response); err != nil {
		if s.Evidence != nil {
			s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: observability.CacheReject, Outcome: "rejected"})
		}
		return nil, false
	}
	if s.Evidence != nil {
		s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: observability.CacheHit, Outcome: "hit"})
	}
	return response, true
}

func responseTargetSurface(req contracts.Request, plan catalog.RoutePlan) contracts.Surface {
	if len(plan.Members) == 0 || plan.Members[0].TargetSurface == "" {
		switch req.Protocol {
		case contracts.SurfaceOpenAIChat:
			return contracts.SurfaceOpenAIResponses
		default:
			return req.Protocol
		}
	}
	return contracts.Surface(plan.Members[0].TargetSurface)
}

func (s *DispatchService) responseCacheSet(ctx context.Context, req contracts.Request, plan catalog.RoutePlan, response *contracts.Response) {
	if response == nil || response.StatusCode < 200 || response.StatusCode > 299 || len(response.Body) == 0 {
		return
	}
	spec, ok := s.responseCacheSpec(ctx, req, plan)
	if !ok {
		return
	}
	err := s.ResponseCache.SetValidated(ctx, spec, response.Body, func(body []byte) error {
		candidate := &contracts.Response{StatusCode: response.StatusCode, Body: body}
		return validateProviderResponse(candidate)
	})
	if s.Evidence != nil {
		op := observability.CacheWrite
		outcome := "stored"
		if err != nil {
			op, outcome = observability.CacheReject, "rejected"
		}
		s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindResponseL0, Layer: "l0", Operation: op, Outcome: outcome})
	}
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
	copyReq.Headers.Del("X-Cartethyia-Provider")
	copyReq.Headers.Del("X-Cartethyia-Continuation-Scope")
	copyReq.Headers.Del("X-Cartethyia-Catalog-Generation")
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

	if copyReq.Model == "" {
		copyReq.Model = modelFromBody(copyReq.Body)
	}
	if copyReq.Protocol == contracts.ProtocolOpenAIChat || copyReq.Protocol == contracts.ProtocolOpenAIResponse || copyReq.Protocol == contracts.ProtocolAnthropic {
		// Apply in-place edge-case healing (model suffix extraction, tool call/response healing, developer role normalization)
		sanitizedBody, cleanModel, sanitizeErr := SanitizeSameSurfaceRequest(ctx, copyReq.Protocol, copyReq.Model, copyReq.Body)
		if sanitizeErr == nil && len(sanitizedBody) > 0 {
			copyReq.Body = sanitizedBody
			if cleanModel != "" {
				copyReq.Model = cleanModel
			}
		}
		// Fast path: validate JSON and extract model without full decode/encode.
		// The sanitizer already did tool healing and field normalization.
		prepared, transformErr := transforms.NormalizeRequestSameSurface(ctx, copyReq.Protocol, copyReq.Body, copyReq.Stream, copyReq.Model)
		if transformErr != nil {
			return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request normalization failed", transformErr)
		}
		copyReq.Body = prepared.Body
		if copyReq.Model == "" {
			copyReq.Model = prepared.Request.Model
		}
		if s.Evidence != nil {
			s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindTokenSaverL0, Layer: "l0", Operation: observability.CacheLookup, Outcome: "miss"})
		}
		if saverReq, changed := applyTokenSaver(ctx, prepared.Request); changed {
			// Token saver needs full NormalizedRequest. Decode on demand from
			// the sanitized body — the fast path deferred this work.
			fullPrepared, fullErr := transforms.NormalizeRequest(ctx, copyReq.Protocol, copyReq.Body, copyReq.Stream)
			if fullErr != nil {
				return nil, dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "request normalization failed", fullErr)
			}
			saverReq, _ = applyTokenSaver(ctx, fullPrepared.Request)
			if s.Evidence != nil {
				s.Evidence.ObserveCache(observability.CacheEvidence{Kind: observability.CacheKindTokenSaverL0, Layer: "l0", Operation: observability.CacheWrite, Outcome: "stored"})
			}
			body, encodeErr := transforms.EncodeNormalizedRequest(ctx, copyReq.Protocol, saverReq, fullPrepared.Body)
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

func (s *DispatchService) resolveCatalog(ctx context.Context, req *contracts.Request) (catalog.RoutePlan, error) {
	if s.Catalog == nil {
		return catalog.RoutePlan{
			RequestedModel: req.Model,
			Strategy:       catalog.RouteStrategySingle,
			Members: []catalog.RouteMember{{
				ProviderID: defaultProviderForSurface(req.Protocol), ClientModelID: req.Model,
				UpstreamModelID: req.Model, Surface: req.Protocol,
			}},
		}, nil
	}
	snapshot, _, err := s.Catalog.Current(ctx)
	if err != nil {
		return catalog.RoutePlan{}, dispatchError(codeDispatchCatalog, contracts.ErrorTransient, http.StatusServiceUnavailable, "model catalog is temporarily unavailable", err)
	}
	plan, err := snapshot.Plan(req.Model, req.Protocol)
	if errors.Is(err, catalog.ErrAmbiguousModel) {
		qualified := defaultProviderForSurface(req.Protocol) + ":" + req.Model
		if fallbackPlan, fallbackErr := snapshot.Plan(qualified, req.Protocol); fallbackErr == nil {
			fallbackPlan.RequestedModel = req.Model
			return fallbackPlan, nil
		}
	}
	if err != nil {
		return catalog.RoutePlan{}, dispatchError(codeDispatchCatalog, contracts.ErrorInvalidRequest, http.StatusBadRequest, "requested model or surface is unavailable", err)
	}
	return plan, nil
}

func operationLabel(operation transforms.OperationKind) string {
	switch operation {
	case transforms.OperationCompactV1, transforms.OperationCompactV2:
		return "compact"
	case transforms.OperationGenerate:
		return "generate"
	default:
		return "unknown"
	}
}

func (s *DispatchService) observeFailureExhaustion(failure *Failure) {
	if s == nil || s.Evidence == nil || failure == nil {
		return
	}
	reason := observability.ExhaustionCandidate
	switch failure.Kind {
	case FailureRateLimit, FailureTransient, FailureServerError, FailureCapacity:
		reason = observability.ExhaustionNetwork
	case FailureAuthentication, FailureReauthenticationRequired:
		reason = observability.ExhaustionCredential
	case FailureQuota:
		reason = observability.ExhaustionQuota
	case FailureTranslation, FailureUnsupported:
		reason = observability.ExhaustionTranslation
	}
	s.Evidence.ObserveTypedExhaustion(reason, failure.CodeString())
}

func (s *DispatchService) observeRoutePlan(req contracts.Request, plan catalog.RoutePlan) {
	if s == nil || s.Evidence == nil {
		return
	}
	source := string(plan.SourceSurface)
	if source == "" {
		source = string(req.Protocol)
	}
	version := "none"
	if plan.Operation == transforms.OperationCompactV1 {
		version = "v1"
	}
	if plan.Operation == transforms.OperationCompactV2 {
		version = "v2"
	}
	s.Evidence.ObserveOperation(observability.OperationEvidence{Operation: operationLabel(plan.Operation), CompactionVersion: version, Bridge: "none", Outcome: observability.PlanOutcomePlanned})
	for _, member := range plan.Members {
		target := string(member.TargetSurface)
		if target == "" {
			target = string(member.Surface)
		}
		action := observability.PlanActionTranslate
		if source == target {
			action = observability.PlanActionPreserve
		}
		s.Evidence.ObserveCompatibilityPlan(observability.CompatibilityPlanEvidence{
			SourceSurface: source, TargetSurface: target, Profile: "unknown-standard",
			Action: action, Outcome: observability.PlanOutcomePlanned, Operation: operationLabel(plan.Operation),
		})
	}
	for _, exclusion := range plan.Exclusions {
		s.Evidence.ObserveCapability(observability.CapabilityEvidence{Code: exclusion.Code, Operation: operationLabel(plan.Operation), Feature: string(exclusion.Feature)})
	}
}

func defaultProviderForSurface(surface contracts.Surface) string {
	switch surface {
	case contracts.SurfaceAnthropic:
		return "anthropic"
	case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses, contracts.SurfaceImages:
		return "openai"
	default:
		return "default"
	}
}

func (s *DispatchService) CatalogStatus() catalog.RefreshStatus {
	if s == nil || s.Catalog == nil {
		return catalog.RefreshStatus{}
	}
	if store, ok := s.Catalog.(interface{ Status() catalog.RefreshStatus }); ok {
		return store.Status()
	}
	return catalog.RefreshStatus{}
}

func admissionKeys(req contracts.Request) map[string]string {
	keys := map[string]string{"global": "global"}
	if req.Stream {
		keys["stream"] = "stream"
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

func (t validatingTransport) ProposeRepair(acct Account, req contracts.Request, ruleID string) (providers.RepairProposal, bool) {
	proposer, ok := t.next.(CompatibilityRepairTransport)
	if !ok {
		return providers.RepairProposal{}, false
	}
	return proposer.ProposeRepair(acct, req, ruleID)
}

func contractKind(kind FailureKind) contracts.ErrorKind {
	switch kind {
	case FailureInvalidRequest:
		return contracts.ErrorInvalidRequest
	case FailureUnsupported:
		return contracts.ErrorUnsupported
	case FailureTranslation:
		return contracts.ErrorTranslation
	case FailureEntitlement:
		return contracts.ErrorEntitlement
	case FailureContentPolicy:
		return contracts.ErrorContentPolicy
	case FailureReauthenticationRequired:
		return contracts.ErrorReauthenticationRequired
	case FailureCapacity:
		return contracts.ErrorCapacity
	case FailureEmptyOutput:
		return contracts.ErrorEmptyOutput
	case FailureAuthentication:
		return contracts.ErrorAuthentication
	case FailureRateLimit:
		return contracts.ErrorRateLimit
	case FailureQuota:
		return contracts.ErrorQuota
	case FailureTransient:
		return contracts.ErrorTransient
	case FailureServerError:
		return contracts.ErrorServerError
	case FailureFatal, FailureAborted, FailureUnknown:
		return contracts.ErrorFatal
	default:
		return contracts.ErrorFatal
	}
}

func (s *DispatchService) enqueueMetadata(meta observability.Metadata) {
	if s.Metadata != nil {
		if err := s.Metadata.Enqueue(meta); err != nil {
			s.recordSideEffectFailure()
		}
	}
}

// recordDispatchSideEffects owns the fail-open usage and continuation writes
// shared by buffered responses and stream terminal finalization. DispatchService
// remains the lifecycle owner; this seam only prevents the two boundaries from
// drifting in their side-effect/error-accounting behavior.
func (s *DispatchService) recordDispatchSideEffects(ctx context.Context, req contracts.Request, tokens usage.Tokens, responseID string) {
	s.recordFailOpen(func() error { return s.recordUsageTokens(req, tokens) })
	s.recordFailOpen(func() error { return s.recordContinuationID(ctx, req, responseID) })
}

func (s *DispatchService) recordFailOpen(effect func() error) {
	if effect == nil {
		return
	}
	if err := effect(); err != nil {
		s.recordSideEffectFailure()
	}
}

func (s *DispatchService) finalizeStream(ctx context.Context, req contracts.Request, stream *Stream, meta *observability.Metadata, streamErr error) {
	if stream == nil || meta == nil {
		return
	}
	tokens := stream.UsageTokens()
	meta.InputTokens = tokens.Input
	meta.OutputTokens = tokens.Output
	meta.CachedTokens = tokens.CachedRead
	meta.CacheWriteTokens = tokens.CachedWrite
	responseID := stream.ResponseID()
	if streamErr != nil {
		responseID = ""
	}
	s.recordDispatchSideEffects(ctx, req, tokens, responseID)
	completeMetadata(meta, streamErr, errors.Is(streamErr, ErrClientDisconnect), time.Now())
	s.enqueueMetadata(*meta)
}

func (s *DispatchService) recordUsageTokens(req contracts.Request, tokens usage.Tokens) error {
	if s.Usage == nil {
		return nil
	}
	requestID := headerValue(req.Headers, "X-Request-ID")
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	event := usage.Event{
		RequestID: requestID, Attempt: 1,
		Model: req.Model, StartedAt: now(), EndedAt: now(),
	}
	event.Tokens = tokens
	if err := s.Usage.Register(event); err != nil && !errors.Is(err, usage.ErrDuplicate) {
		return dispatchError(codeDispatchUsage, contracts.ErrorFatal, http.StatusInternalServerError, "usage event could not be recorded", err)
	}
	return nil
}

func parseUsage(body []byte) usage.Tokens {
	if tokens, ok := healing.ExtractProviderTokens("", "", body); ok {
		return tokens
	}
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

func responseContinuationID(body []byte) string {
	var payload struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return payload.ID
}

func (s *DispatchService) recordContinuationID(ctx context.Context, req contracts.Request, responseID string) error {
	if req.Protocol != contracts.ProtocolOpenAIResponse || s.Continuations == nil || responseID == "" {
		return nil
	}
	if req.ContinuationScope == "" {
		return nil
	}
	binding, err := continuationBinding(req)
	if err != nil {
		return dispatchError(codeDispatchInvalidRequest, contracts.ErrorInvalidRequest, http.StatusBadRequest, "continuation is unavailable", err)
	}
	if err := s.Continuations.Put(ctx, continuation.State{
		ID: responseID, ResponseID: responseID, Scope: binding.Scope,
		Provider: binding.Provider, Model: binding.Model, Generation: binding.Generation,
	}); err != nil {
		return dispatchError(codeDispatchProvider, contracts.ErrorFatal, http.StatusInternalServerError, "continuation could not be recorded", err)
	}
	return nil
}

func continuationBinding(req contracts.Request) (continuation.Binding, error) {
	if req.ContinuationScope == "" {
		return continuation.Binding{}, continuation.ErrUnauthorized
	}
	provider := defaultProviderForSurface(req.Protocol)
	if req.Model == "" {
		return continuation.Binding{}, &continuation.Error{
			Code: continuation.CodeInvalid, Op: "binding", Message: "continuation model is required",
		}
	}
	return continuation.Binding{Scope: req.ContinuationScope, Provider: provider, Model: req.Model}, nil
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
	codecs      *transforms.Registry
	mu          sync.Mutex
	reader      apicontracts.StreamReader
}

func (r *streamResponse) StatusCode() int      { return r.status }
func (r *streamResponse) ContentType() string  { return r.contentType }
func (r *streamResponse) Headers() http.Header { return r.headers.Clone() }
func (r *streamResponse) Body() apicontracts.StreamReader {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reader == nil {
		r.reader = NewCodecStreamBridge(r.stream, r.surface, r.model, r.codecs)
	}
	return r.reader
}

var _ apicontracts.ProxyService = (*DispatchService)(nil)
