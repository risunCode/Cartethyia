package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
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
