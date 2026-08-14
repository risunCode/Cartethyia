package admin

import "net/http"
import "strings"

// RegisterTools wires /v2/admin/tools/* routes.
func RegisterTools(mux *http.ServeMux, services Services) {
	if services.Tools == nil {
		return
	}
	t := services.Tools

	mux.HandleFunc("/v2/admin/tools/cache/", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/v2/admin/tools/cache/")
		name = strings.Trim(name, "/")
		if name == "" {
			WriteError(w, NewError(CodeInvalidRequest, "cache name is required"))
			return
		}
		result, err := t.Cache(r.Context(), name)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	}))

	mux.HandleFunc("/v2/admin/tools/reindex", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Target string `json:"target"`
		}
		if err := decodeJSON(r, &body); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := t.Reindex(r.Context(), body.Target)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	}))

	mux.HandleFunc("/v2/admin/tools/probe", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input ProbeInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := t.Probe(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		// Probe bodies and upstream headers are never operator payload. Keep
		// only bounded status/latency metadata at this boundary.
		result.Body = ""
		result.Headers = nil
		WriteData(w, http.StatusOK, result)
	}))

	mux.HandleFunc("/v2/admin/tools/restart", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		result, err := t.Restart(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusAccepted, result)
	}))
}
