package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type routeConsoleLogs struct{}

func (routeConsoleLogs) List(context.Context, ConsoleLogQuery) ([]ConsoleLogEntry, error) {
	return []ConsoleLogEntry{{ID: "event-1", Timestamp: "2026-08-13T10:00:00Z", Event: "incoming_request", Message: "bounded"}}, nil
}

type routeUsage struct{}

func (routeUsage) Usage(context.Context, TelemetryQuery) (UsageSummary, error) {
	return UsageSummary{Requests: 1}, nil
}

func (routeUsage) Clients(context.Context, TelemetryQuery) (ClientDistribution, error) {
	return ClientDistribution{Total: 1, Unknown: 1, Items: []ClientUsageItem{{Client: "unknown", Count: 1, Percentage: 100}}}, nil
}

type routeCatalog struct{}

func (routeCatalog) Providers(context.Context) ([]CatalogProvider, error) {
	return []CatalogProvider{{ID: "openai", DisplayName: "OpenAI"}}, nil
}

type routeTelemetry struct {
	last TelemetryQuery
}

func (t *routeTelemetry) Overview(context.Context, TelemetryQuery) (TelemetryOverview, error) {
	return TelemetryOverview{Requests: 1}, nil
}

func (t *routeTelemetry) Requests(_ context.Context, input TelemetryQuery) ([]TelemetryBucket, error) {
	t.last = input
	return []TelemetryBucket{{Timestamp: "2026-08-13T10:00:00Z", Count: 1}}, nil
}

func (t *routeTelemetry) Errors(context.Context, TelemetryQuery) ([]TelemetryBucket, error) {
	return nil, nil
}

func (t *routeTelemetry) Upstream(context.Context, TelemetryQuery) ([]TelemetryBucket, error) {
	return nil, nil
}

func (t *routeTelemetry) RequestDetail(context.Context, string) (RequestDetail, error) {
	return RequestDetail{}, nil
}

func TestV2ObservabilityRoutesUseContractMethods(t *testing.T) {
	mux := http.NewServeMux()
	telemetry := &routeTelemetry{}
	services := Services{
		Telemetry:   telemetry,
		ConsoleLogs: routeConsoleLogs{},
		Usage:       routeUsage{},
		Catalog:     routeCatalog{},
	}
	RegisterTelemetry(mux, services)
	RegisterConsole(mux, services)
	RegisterUsage(mux, services)
	RegisterCatalog(mux, services)

	tests := []struct {
		method string
		path   string
		body   string
		want   int
	}{
		{http.MethodGet, "/console/logs?limit=10", "", http.StatusOK},
		{http.MethodGet, "/console/telemetry/usage", "", http.StatusOK},
		{http.MethodGet, "/console/telemetry/clients", "", http.StatusOK},
		{http.MethodGet, "/console/catalog/providers", "", http.StatusOK},
		{http.MethodGet, "/console/telemetry/usage", "", http.StatusOK},
	}
	for _, tc := range tests {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s %s: status=%d want=%d body=%s", tc.method, tc.path, rec.Code, tc.want, rec.Body.String())
		}
	}
	if telemetry.last.Surface != "" {
		t.Fatalf("telemetry request surface unexpectedly set by unrelated route: %q", telemetry.last.Surface)
	}
}

func TestV2RequestLogForcesCanonicalClientActionSurface(t *testing.T) {
	mux := http.NewServeMux()
	telemetry := &routeTelemetry{}
	RegisterTelemetry(mux, Services{Telemetry: telemetry})
	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/requests?surface=provider", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if telemetry.last.Surface != "client_action" {
		t.Fatalf("surface=%q want client_action", telemetry.last.Surface)
	}
}

func TestTelemetryQueryIsBoundedAndDeterministic(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/console/telemetry/overview?to=2026-08-13T11:00:00Z&from=2026-08-13T10:00:00Z&period=24h&bucket=hour&cursor=page-2&limit=5000&group_by=provider&surface=provider", nil)
	query := parseTelemetryQuery(req)
	if query.From != "2026-08-13T10:00:00Z" || query.To != "2026-08-13T11:00:00Z" || query.Period != "24h" || query.Bucket != "hour" || query.Cursor != "page-2" || query.Limit != 1000 || query.GroupBy != "provider" {
		t.Fatalf("bounded telemetry query = %#v", query)
	}

	req = httptest.NewRequest(http.MethodGet, "/console/telemetry/overview?from=%0Asecret&bucket=raw&group_by=account&limit=oops", nil)
	query = parseTelemetryQuery(req)
	if query.From != "" || query.Bucket != "" || query.GroupBy != "" || query.Limit != 0 {
		t.Fatalf("unsafe telemetry query values were retained: %#v", query)
	}
}
