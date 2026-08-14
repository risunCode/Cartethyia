package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const customProvidersPath = "/v2/admin/custom-providers"

// RegisterCustomProviders wires CRUD for persisted custom provider metadata.
// Secrets are never accepted; credentialRef must point to the daemon secret
// store and is returned only as an opaque reference.
func RegisterCustomProviders(mux *http.ServeMux, services Services) {
	mux.HandleFunc(customProvidersPath, requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		if services.CustomProviders == nil {
			WriteError(w, NewError(CodeUnavailable, "custom provider service is unavailable"))
			return
		}
		items, err := services.CustomProviders.List(r.Context())
		if err != nil {
			writeCustomProviderError(w, err)
			return
		}
		WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": items})
	}))

	mux.HandleFunc(customProvidersPath+"/", func(w http.ResponseWriter, r *http.Request) {
		if services.CustomProviders == nil {
			WriteError(w, NewError(CodeUnavailable, "custom provider service is unavailable"))
			return
		}
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, customProvidersPath+"/"), "/")
		if id == "" || strings.Contains(id, "/") || len(id) > 128 {
			WriteError(w, NewError(CodeInvalidRequest, "invalid custom provider id"))
			return
		}
		switch r.Method {
		case http.MethodGet:
			item, err := services.CustomProviders.Get(r.Context(), id)
			if err != nil {
				writeCustomProviderError(w, err)
				return
			}
			WriteDataRequest(w, r, http.StatusOK, item)
		case http.MethodPut, http.MethodPost:
			var input CustomProviderInput
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid custom provider body"))
				return
			}
			if input.ID == "" {
				input.ID = id
			}
			item, err := services.CustomProviders.Upsert(r.Context(), input)
			if err != nil {
				writeCustomProviderError(w, err)
				return
			}
			WriteDataRequest(w, r, http.StatusOK, item)
		case http.MethodDelete:
			if err := services.CustomProviders.Delete(r.Context(), id); err != nil {
				writeCustomProviderError(w, err)
				return
			}
			WriteDataRequest(w, r, http.StatusOK, map[string]any{"deleted": true})
		default:
			WriteError(w, NewError(CodeInvalidRequest, "method not allowed"))
		}
	})
}

func writeCustomProviderError(w http.ResponseWriter, err error) {
	var adminErr *Error
	if errors.As(err, &adminErr) {
		WriteError(w, adminErr)
		return
	}
	WriteError(w, NewError(CodeUnavailable, "custom provider operation failed"))
}
