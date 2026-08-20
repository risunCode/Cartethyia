// Package action owns the canonical external POST /v1/action ingress. It is
// intentionally separate from the dashboard Web Request action under V2.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/cartethyia/daemon/internal/telemetry"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/gateway/middleware"
	"net/http"
	"strings"
	"time"
)

const ActionPath = "/v1/action"

// streamEvidence is an optional response-side metadata seam. Implementations
// may expose bounded selected account/proxy identity without changing the
// narrow Stream contract or carrying credentials.
type streamEvidence interface {
	RequestMetadata() RequestMetadata
}

func registerAction(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(ActionPath, func(w http.ResponseWriter, r *http.Request) { handleAction(w, r, deps.Proxy, deps.Evidence) })
}

func handleAction(w http.ResponseWriter, r *http.Request, proxy ProxyService, evidence *telemetry.Registry) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if proxy == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "action proxy is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "action requires Content-Type: application/json")
		return
	}
	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}
	var envelope struct {
		Protocol string `json:"protocol"`
		Model    string `json:"model"`
		Stream   bool   `json:"stream"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "action body must be a JSON object")
		return
	}
	protocol := contracts.Surface(envelope.Protocol)
	if !protocol.IsValid() || protocol == contracts.SurfaceWebSearch {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "action protocol is unsupported")
		return
	}

	started := time.Now()
	baseEvent := telemetry.RequestEvent{
		RequestID:    middleware.RequestIDFrom(r.Context()),
		TraceID:      middleware.TraceIDFrom(r.Context()),
		Method:       r.Method,
		Path:         ActionPath,
		Provider:     protocolProvider(protocol),
		Model:        strings.TrimSpace(envelope.Model),
		Surface:      telemetry.SurfaceHTTP,
		Origin:       boundedOrigin(r.Header.Get("X-Request-Origin")),
		ClientFamily: middleware.DetectClient(r).Family,
		StartedAt:    started,
	}
	emitLifecycle(r, evidence, withLifecycle(baseEvent, telemetry.EventIncomingRequest, telemetry.StageRequestStart, "", telemetry.CodeIncoming))
	emitLifecycle(r, evidence, withLifecycle(baseEvent, telemetry.EventRouteSelected, telemetry.StageRouteAttempt, "", telemetry.CodeRouteSelected))
	emitLifecycle(r, evidence, withLifecycle(baseEvent, telemetry.EventProviderAttempt, telemetry.StageProviderCall, "", telemetry.CodeProviderAttempt))

	stream, err := DispatchContext(r.Context(), proxy, &contracts.Request{Protocol: protocol, Model: envelope.Model, Headers: r.Header.Clone(), Body: body, Stream: envelope.Stream})
	if err != nil {
		outcome := telemetry.OutcomeError
		if errors.Is(err, context.Canceled) {
			outcome = telemetry.OutcomeCancelled
		}
		failedKey := telemetry.EventRequestFailed
		if outcome == telemetry.OutcomeCancelled {
			failedKey = telemetry.EventRequestCancelled
		}
		failed := withLifecycle(baseEvent, failedKey, telemetry.StageProviderCall, "", actionErrorCode(err))
		applyLifecycleEvidence(&failed, err)
		emitLifecycle(r, evidence, failed)
		completed := withLifecycle(baseEvent, telemetry.EventRequestCompleted, telemetry.StageTerminal, outcome, actionErrorCode(err))
		applyLifecycleEvidence(&completed, err)
		completed.LatencyMS = time.Since(started).Milliseconds()
		completed.EndedAt = time.Now()
		emitLifecycle(r, evidence, completed)
		WriteError(w, err)
		return
	}
	if metadata, ok := stream.(streamEvidence); ok {
		applyRequestMetadata(&baseEvent, metadata.RequestMetadata())
	}
	succeeded := withLifecycle(baseEvent, telemetry.EventRequestSucceeded, telemetry.StageProviderCall, telemetry.OutcomeSuccess, telemetry.CodeRequestSucceeded)
	emitLifecycle(r, evidence, succeeded)
	completed := withLifecycle(baseEvent, telemetry.EventRequestCompleted, telemetry.StageTerminal, telemetry.OutcomeSuccess, telemetry.CodeRequestCompleted)
	completed.LatencyMS = time.Since(started).Milliseconds()
	completed.EndedAt = time.Now()
	emitLifecycle(r, evidence, completed)
	_ = WriteStream(r.Context(), w, stream)
}

func withLifecycle(base telemetry.RequestEvent, key telemetry.LifecycleKey, stage telemetry.Stage, outcome telemetry.Outcome, code string) telemetry.RequestEvent {
	base.EventKey = string(key)
	base.Stage = stage
	base.Outcome = outcome
	base.ErrorCode = code
	return base
}

func emitLifecycle(r *http.Request, evidence *telemetry.Registry, event telemetry.RequestEvent) {
	if evidence != nil {
		_ = evidence.RecordEvent(r.Context(), event)
	}
}

func applyRequestMetadata(event *telemetry.RequestEvent, metadata RequestMetadata) {
	if event == nil {
		return
	}
	if metadata.Validate() != nil {
		return
	}
	if metadata.RequestID != "" {
		event.RequestID = metadata.RequestID
	}
	if metadata.TraceID != "" {
		event.TraceID = metadata.TraceID
	}
	if metadata.Origin != "" {
		event.Origin = metadata.Origin
	}
	if metadata.ClientFamily != "" {
		event.ClientFamily = metadata.ClientFamily
	}
	if metadata.AccountID != "" {
		event.AccountID = metadata.AccountID
	}
	if metadata.AccountEmail != "" {
		event.AccountEmail = metadata.AccountEmail
	}
	if metadata.AccountName != "" {
		event.AccountName = metadata.AccountName
	}
	event.AccountDisplay = metadata.AccountDisplay
	if event.AccountDisplay == "" {
		event.AccountDisplay, _ = telemetry.ResolveAccountDisplay(metadata.AccountEmail, metadata.AccountName, metadata.AccountID)
	}
	if metadata.ProxyID != "" {
		event.ProxyID = metadata.ProxyID
	}
	if metadata.ProxyName != "" {
		event.ProxyName = metadata.ProxyName
	}
	if metadata.ProxyDisplay != "" {
		event.ProxyDisplay = metadata.ProxyDisplay
	}
	if metadata.ProxySource != "" {
		event.ProxySource = metadata.ProxySource
	}
	if event.ProxyDisplay == "" {
		event.ProxyDisplay, _ = telemetry.ResolveProxyDisplay(metadata.ProxyName, metadata.ProxyID)
	}
}

func applyLifecycleEvidence(event *telemetry.RequestEvent, err error) {
	if event == nil || err == nil {
		return
	}
	var lifecycle interface {
		LifecycleEvidence() (string, bool, int64, bool, string, string, string)
	}
	if errors.As(err, &lifecycle) {
		code, retryable, retryAfter, alternate, source, scope, phase := lifecycle.LifecycleEvidence()
		if code != "" {
			event.ErrorCode = code
		}
		event.Retryable, event.RetryAfterMS = retryable, retryAfter
		event.AlternateAccountEligible = alternate
		event.RateSource, event.RateScope, event.RatePhase = source, scope, phase
	}
}

func protocolProvider(protocol contracts.Surface) string {
	switch protocol {
	case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses, contracts.SurfaceImages:
		return "openai"
	case contracts.SurfaceAnthropic:
		return "anthropic"
	default:
		return "unknown"
	}
}

func boundedOrigin(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 32 {
		return value[:32]
	}
	return value
}

func actionErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var codeCarrier interface{ CodeString() string }
	if errors.As(err, &codeCarrier) {
		if code := codeCarrier.CodeString(); code != "" {
			return code
		}
	}
	var lifecycle interface {
		LifecycleEvidence() (string, bool, int64, bool, string, string, string)
	}
	if errors.As(err, &lifecycle) {
		if code, _, _, _, _, _, _ := lifecycle.LifecycleEvidence(); code != "" {
			return code
		}
	}
	var routeErr *contracts.RouteError
	if errors.As(err, &routeErr) && routeErr.CodeString() != "" {
		return routeErr.CodeString()
	}
	return "action.failed"
}
