package admin

import (
	"net/http"
	"strings"
)

// RegisterTelemetry wires /v2/admin/telemetry/* routes.
func RegisterTelemetry(mux *http.ServeMux, services Services) {
	if services.Telemetry == nil {
		return
	}
	tel := services.Telemetry

	mux.HandleFunc("/v2/admin/telemetry/overview", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		query := parseTelemetryQuery(r)
		overview, err := tel.Overview(r.Context(), query)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, overview)
	}))

	mux.HandleFunc("/v2/admin/telemetry/requests", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		query := parseTelemetryQuery(r)
		// Request Log only exposes canonical client POST /v1/action evidence.
		query.Surface = "client_action"
		buckets, err := tel.Requests(r.Context(), query)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": buckets, "surface": query.Surface})
	}))

	mux.HandleFunc("/v2/admin/telemetry/errors", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		query := parseTelemetryQuery(r)
		buckets, err := tel.Errors(r.Context(), query)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": buckets})
	}))

	mux.HandleFunc("/v2/admin/telemetry/upstream", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		query := parseTelemetryQuery(r)
		buckets, err := tel.Upstream(r.Context(), query)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": buckets})
	}))

}

func parseTelemetryQuery(r *http.Request) TelemetryQuery {
	q := r.URL.Query()
	return TelemetryQuery{
		From:    boundedQueryValue(q.Get("from"), 64),
		To:      boundedQueryValue(q.Get("to"), 64),
		Period:  boundedPeriod(q.Get("period")),
		Bucket:  boundedBucket(q.Get("bucket")),
		Cursor:  boundedQueryValue(q.Get("cursor"), 128),
		Limit:   boundedLimit(q.Get("limit")),
		GroupBy: boundedGroupBy(q.Get("group_by")),
	}
}

func boundedQueryValue(raw string, max int) string {
	if raw == "" || len(raw) > max || strings.IndexFunc(raw, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) >= 0 {
		return ""
	}
	return raw
}

func boundedPeriod(raw string) string {
	switch raw {
	case "1h", "24h", "7d", "30d", "all":
		return raw
	default:
		return ""
	}
}

func boundedBucket(raw string) string {
	switch raw {
	case "minute", "hour", "day", "auto":
		return raw
	default:
		return ""
	}
}

func boundedGroupBy(raw string) string {
	switch raw {
	case "model", "provider", "client":
		return raw
	default:
		return ""
	}
}

func boundedLimit(raw string) int {
	if raw == "" {
		return 0
	}
	n := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
		if n > 1000 {
			return 1000
		}
	}
	return n
}

// RegisterUsage wires aggregate usage and client-distribution reads. These
// routes are backed by persisted canonical request evidence through UsageService.
func RegisterUsage(mux *http.ServeMux, services Services) {
	if services.Usage == nil {
		return
	}
	usage := services.Usage
	mux.HandleFunc("/v2/admin/telemetry/usage", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		result, err := usage.Usage(r.Context(), parseTelemetryQuery(r))
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, result)
	}))
	mux.HandleFunc("/v2/admin/telemetry/clients", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		result, err := usage.Clients(r.Context(), parseTelemetryQuery(r))
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, result)
	}))
}
