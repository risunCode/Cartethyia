package admin

import (
	"net/http"
	"strconv"
	"strings"
)

// RegisterProxies wires /v2/admin/proxies/*, /v2/admin/proxy-settings, and
// /v2/admin/web-search-routing routes.
func RegisterProxies(mux *http.ServeMux, services Services) {
	if services.Proxies == nil {
		return
	}
	p := services.Proxies

	mux.HandleFunc("/v2/admin/proxies", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:  listProxies(p),
		http.MethodPost: createProxy(p),
	}))

	mux.HandleFunc("/v2/admin/proxies/", func(w http.ResponseWriter, r *http.Request) {
		handleProxySubresource(w, r, p)
	})

	mux.HandleFunc("/v2/admin/proxies/scrape/countries", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		countries, err := p.Countries(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"countries": countries})
	}))

	mux.HandleFunc("/v2/admin/proxies/scrape/catalog", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		WriteData(w, http.StatusOK, map[string]any{"sources": p.ScrapeCatalog(r.Context())})
	}))

	mux.HandleFunc("/v2/admin/proxies/search", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input ProxySearchInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		results, err := p.Search(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"items": results})
	}))

	mux.HandleFunc("/v2/admin/proxies/import", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input ProxyImportInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := p.Import(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	}))

	mux.HandleFunc("/v2/admin/proxies/scrape", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input ProxyScrapeInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := p.Scrape(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	}))

	mux.HandleFunc("/v2/admin/proxy-settings", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:  getSettings(p),
		http.MethodPost: patchSettings(p),
	}))

	mux.HandleFunc("/v2/admin/web-search-routing", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		settings, err := p.Settings(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}))
}

func handleProxySubresource(w http.ResponseWriter, r *http.Request, svc ProxyService) {
	rest := strings.TrimPrefix(r.URL.Path, "/v2/admin/proxies/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		WriteError(w, NewError(CodeNotFound, "proxy not found"))
		return
	}

	id := parts[0]
	tail := parts[1:]

	switch {
	case len(tail) == 0:
		switch r.Method {
		case http.MethodPatch:
			var input ProxyInput
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
	case len(tail) == 1 && tail[0] == "test":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		result, err := svc.Test(r.Context(), id)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	default:
		WriteError(w, NewError(CodeNotFound, "proxy subresource not found"))
	}
}

func listProxies(svc ProxyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		items, err := svc.List(r.Context(), limit)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"items": items})
	}
}

func createProxy(svc ProxyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input ProxyInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		record, err := svc.Create(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusCreated, record)
	}
}

func getSettings(svc ProxyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings, err := svc.Settings(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}
}

func patchSettings(svc ProxyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input ProxySettingsInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		settings, err := svc.PatchSettings(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}
}
