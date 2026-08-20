package api

import (
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type routeRequestDetail struct {
	lastID string
	reply  consolecontracts.RequestDetail
	err    error
}

func (r *routeRequestDetail) Overview(context.Context, consolecontracts.TelemetryQuery) (consolecontracts.TelemetryOverview, error) {
	return consolecontracts.TelemetryOverview{}, nil
}

func (r *routeRequestDetail) Requests(context.Context, consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error) {
	return nil, nil
}

func (r *routeRequestDetail) Errors(context.Context, consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error) {
	return nil, nil
}

func (r *routeRequestDetail) Upstream(context.Context, consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error) {
	return nil, nil
}

func (r *routeRequestDetail) RequestDetail(_ context.Context, id string) (consolecontracts.RequestDetail, error) {
	r.lastID = id
	if r.err != nil {
		return consolecontracts.RequestDetail{}, r.err
	}
	return r.reply, nil
}

func TestRequestDetailHandlerReturnsBoundedDetail(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{reply: consolecontracts.RequestDetail{
		ID:           "42",
		TraceID:      "trace-42",
		Model:        "gpt-test",
		Provider:     "openai",
		Surface:      "client_action",
		Endpoint:     "chat",
		APIKeyPrefix: "abc",
		Status:       200,
		LatencyMs:    1234,
		InputTokens:  7,
		OutputTokens: 9,
		ClientName:   "curl",
		Stream:       true,
		StartedAt:    "2026-08-13T10:00:00Z",
		FinishedAt:   "2026-08-13T10:00:01Z",
	}}
	RegisterTelemetry(mux, Services{Telemetry: store})

	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests/42", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastID != "42" {
		t.Fatalf("handler passed id=%q want 42", store.lastID)
	}
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error envelope: %+v", env.Error)
	}
	raw, err := json.Marshal(env.Data)
	if err != nil {
		t.Fatalf("re-encode data: %v", err)
	}
	var got consolecontracts.RequestDetail
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if got.ID != "42" || got.TraceID != "trace-42" || got.Model != "gpt-test" || got.Provider != "openai" || got.Status != 200 || got.LatencyMs != 1234 || got.InputTokens != 7 || got.OutputTokens != 9 || got.ClientName != "curl" || !got.Stream {
		t.Fatalf("unexpected detail payload: %+v", got)
	}
}

func TestRequestDetailHandlerRejectsBareCollectionPath(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{}
	RegisterTelemetry(mux, Services{Telemetry: store})

	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s want list endpoint 200", rec.Code, rec.Body.String())
	}
	if store.lastID != "" {
		t.Fatalf("store saw id=%q; list path must not invoke detail handler", store.lastID)
	}
}

func TestRequestDetailHandlerEmptyIDReturnsNotFound(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{}
	RegisterTelemetry(mux, Services{Telemetry: store})

	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s want 404", rec.Code, rec.Body.String())
	}
	if store.lastID != "" {
		t.Fatalf("store saw id=%q; empty id must short-circuit", store.lastID)
	}
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if env.Error == nil || env.Error.Code != CodeNotFound {
		t.Fatalf("expected not_found error envelope, got %+v", env.Error)
	}
}

func TestRequestDetailHandlerPropagatesServiceError(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{err: NewError(CodeAdminUnavailable, "observability read is unavailable")}
	RegisterTelemetry(mux, Services{Telemetry: store})

	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests/99", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s want 503", rec.Code, rec.Body.String())
	}
	if store.lastID != "99" {
		t.Fatalf("handler passed id=%q want 99", store.lastID)
	}
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if env.Error == nil || env.Error.Code != CodeAdminUnavailable {
		t.Fatalf("expected unavailable error envelope, got %+v", env.Error)
	}
}

func TestRequestDetailHandlerNotFoundError(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{err: NewError(CodeNotFound, "request not found")}
	RegisterTelemetry(mux, Services{Telemetry: store})

	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests/777", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s want 404", rec.Code, rec.Body.String())
	}
}

func TestRequestDetailHandlerRejectsNonGet(t *testing.T) {
	mux := http.NewServeMux()
	store := &routeRequestDetail{}
	RegisterTelemetry(mux, Services{Telemetry: store})

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		req := httptest.NewRequest(method, "/console/telemetry/requests/1", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s status=%d want 405", method, rec.Code)
		}
	}
	if store.lastID != "" {
		t.Fatalf("non-GET must not invoke detail handler: lastID=%q", store.lastID)
	}
}

// Ensure the existing routeTelemetry stub still satisfies TelemetryService
// after consolecontracts.RequestDetail was added. Embedding the existing stub lets the missing
// interface method be supplied here without touching the shared observability
// test file.
type routeTelemetryConforms struct {
	routeTelemetry
}

func (routeTelemetryConforms) RequestDetail(context.Context, string) (consolecontracts.RequestDetail, error) {
	return consolecontracts.RequestDetail{}, nil
}

var _ TelemetryService = (*routeTelemetryConforms)(nil)
