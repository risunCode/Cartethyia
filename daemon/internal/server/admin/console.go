package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// RegisterConsole wires operator evidence and the explicit V2 Web Request
// action. Each route is omitted when its owning service is unavailable; this
// keeps unsupported product capabilities absent rather than returning fake data.
func RegisterConsole(mux *http.ServeMux, services Services) {
	if services.ConsoleLogs != nil {
		logs := services.ConsoleLogs
		mux.HandleFunc("/v2/admin/console/logs", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			query := ConsoleLogQuery{
				From:   r.URL.Query().Get("from"),
				To:     r.URL.Query().Get("to"),
				Level:  r.URL.Query().Get("level"),
				Scope:  r.URL.Query().Get("scope"),
				Origin: r.URL.Query().Get("origin"),
				Limit:  boundedLimit(r.URL.Query().Get("limit")),
			}
			items, err := logs.List(r.Context(), query)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": items})
		}))

		mux.HandleFunc("/v2/admin/console/logs/stream", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			stream, ok := beginAdminStream(w)
			if !ok {
				return
			}
			tailConsoleLogs(r, stream, logs)
		}))
	}

	if services.WebRequest != nil {
		web := services.WebRequest
		mux.HandleFunc("/v2/admin/console/web-request", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
			var input WebRequestInput
			if err := decodeBoundedJSON(r, &input, 64*1024); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid web request input").WithCause(err))
				return
			}
			if strings.TrimSpace(input.URL) == "" {
				WriteError(w, NewError(CodeInvalidRequest, "web request URL is required"))
				return
			}
			result, err := web.Execute(r.Context(), input)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteDataRequest(w, r, http.StatusOK, result)
		}))
	}
}

func decodeBoundedJSON(r *http.Request, dst any, limit int64) error {
	if r == nil || r.Body == nil {
		return errors.New("request body is required")
	}
	if limit <= 0 {
		return errors.New("request body limit is invalid")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, limit+1))
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("request body contains multiple JSON values")
		}
		return err
	}
	return nil
}

// consoleStreamEvent is the compact wire shape of the live console stream.
// Fields map directly onto the dashboard log normalizer.
type consoleStreamEvent struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Source    string `json:"source"`
	Message   string `json:"message"`
}

// tailConsoleLogs streams an initial recent batch, then tails incrementally:
// every tick reads entries newer than the newest delivered timestamp so the
// stream never replays rows. Timestamps are compared lexically (RFC 3339).
func tailConsoleLogs(r *http.Request, stream *adminStream, logs ConsoleLogService) {
	query := r.URL.Query()
	level := query.Get("level")
	scope := query.Get("scope")
	limit := boundedLimit(query.Get("limit"))
	if limit <= 0 || limit > adminStreamInitLimit {
		limit = adminStreamInitLimit
	}

	ctx := r.Context()
	entries, err := logs.List(ctx, ConsoleLogQuery{Level: level, Scope: scope, Limit: limit})
	if err != nil {
		// Headers are committed already; surface the failure in-stream.
		stream.writeEvent(consoleStreamEvent{
			ID:        "stream-error",
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
			Level:     "error",
			Source:    "console",
			Message:   "console log stream failed to load recent entries",
		})
		return
	}
	newest := emitConsoleEntries(stream, entries, "")

	ticker := time.NewTicker(adminStreamTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tail, err := logs.List(ctx, ConsoleLogQuery{From: newest, Level: level, Scope: scope, Limit: adminStreamTailLimit})
			if err != nil {
				continue // transient read failure; keep the stream alive
			}
			newest = emitConsoleEntries(stream, tail, newest)
		}
	}
}

// emitConsoleEntries writes entries oldest-first and returns the newest
// timestamp delivered (never moving backwards for out-of-order input).
func emitConsoleEntries(stream *adminStream, entries []ConsoleLogEntry, newest string) string {
	sorted := make([]ConsoleLogEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Timestamp < sorted[j].Timestamp })
	for _, entry := range sorted {
		if entry.Timestamp <= newest {
			continue
		}
		stream.writeEvent(consoleStreamEvent{
			ID:        entry.ID,
			Timestamp: entry.Timestamp,
			Level:     entry.Level,
			Source:    consoleStreamSource(entry),
			Message:   entry.Message,
		})
		newest = entry.Timestamp
	}
	return newest
}

func consoleStreamSource(entry ConsoleLogEntry) string {
	if entry.Scope != "" {
		return entry.Scope
	}
	if entry.Provider != "" {
		return entry.Provider
	}
	return "system"
}
