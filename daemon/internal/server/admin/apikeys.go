package admin

import "net/http"
import "strings"

// RegisterAPIKeys wires /v2/admin/keys/* routes.
func RegisterAPIKeys(mux *http.ServeMux, services Services) {
	if services.APIKeys == nil {
		return
	}
	keys := services.APIKeys

	mux.HandleFunc("/v2/admin/keys", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:  listAPIKeys(keys),
		http.MethodPost: createAPIKey(keys),
	}))

	mux.HandleFunc("/v2/admin/keys/", func(w http.ResponseWriter, r *http.Request) {
		handleAPIKeySubresource(w, r, keys)
	})
}

func handleAPIKeySubresource(w http.ResponseWriter, r *http.Request, svc APIKeyService) {
	rest := strings.TrimPrefix(r.URL.Path, "/v2/admin/keys/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		WriteError(w, NewError(CodeNotFound, "key not found"))
		return
	}

	id := parts[0]
	tail := parts[1:]

	switch {
	case len(tail) == 0:
		switch r.Method {
		case http.MethodPatch:
			var input APIKeyInput
			if err := decodeJSON(r, &input); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			record, err := svc.Update(r.Context(), id, input)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, record)
		case http.MethodDelete:
			if err := svc.Delete(r.Context(), id); err != nil {
				WriteError(w, err)
				return
			}
			WriteStatus(w, http.StatusNoContent)
		default:
			writeMethodNotAllowed(w, http.MethodPatch, http.MethodDelete)
		}
	case len(tail) == 1 && (tail[0] == "regenerate" || tail[0] == "revoke"):
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		switch tail[0] {
		case "regenerate":
			result, err := svc.Regenerate(r.Context(), id)
			if err != nil {
				WriteError(w, err)
				return
			}
			result.Key = ""
			if result.Notice == "" {
				result.Notice = "key material is never returned by the admin API"
			}
			WriteData(w, http.StatusOK, result)
		case "revoke":
			if err := svc.Revoke(r.Context(), id); err != nil {
				WriteError(w, err)
				return
			}
			WriteOK(w)
		}
	case len(tail) == 1 && (tail[0] == "share" || tail[0] == "setup-link"):
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		kind := "monitor"
		if tail[0] == "setup-link" {
			kind = "setup"
		}
		baseURL := baseURLFromRequest(r)
		link, err := svc.ShareLink(r.Context(), id, kind, baseURL)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, link)
	case len(tail) == 1 && tail[0] == "revoke-share":
		if r.Method != http.MethodDelete {
			writeMethodNotAllowed(w, http.MethodDelete)
			return
		}
		removed, err := svc.RevokeShareLinks(r.Context(), id)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"removed": removed})
	default:
		WriteError(w, NewError(CodeNotFound, "key subresource not found"))
	}
}

func listAPIKeys(svc APIKeyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := svc.List(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"items": items})
	}
}

func createAPIKey(svc APIKeyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input APIKeyInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := svc.Create(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		if result.Notice == "" {
			result.Notice = "key material is never returned by the admin API"
		}
		// API key bytes are credential material. The service may still return
		// them for internal rotation flows, but this HTTP boundary never does.
		result.Key = ""
		WriteData(w, http.StatusCreated, result)
	}
}

func baseURLFromRequest(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if h := r.Header.Get("X-Forwarded-Proto"); h != "" {
		scheme = h
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}
