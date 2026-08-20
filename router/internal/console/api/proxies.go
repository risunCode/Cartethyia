package api

import (
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"

	"net/http"
	"strings"


	"github.com/cartethyia/daemon/internal/storage/models"
)

// RegisterProxies wires the /console/proxies CRUD surface. When the
// ProxyAdmin dependency is absent the function is a no-op so deployments
// without a proxy repository can still mount the rest of the admin stack.
func RegisterProxies(mux *http.ServeMux, services Services) {
	if services.ProxyAdmin == nil {
		return
	}
	svc := services.ProxyAdmin

	mux.HandleFunc("/console/proxies", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:  listProxiesHandler(svc),
		http.MethodPost: createProxyHandler(svc),
	}))
	mux.HandleFunc("/console/proxies/", func(w http.ResponseWriter, r *http.Request) {
		handleProxySubresource(w, r, svc)
	})
}

func handleProxySubresource(w http.ResponseWriter, r *http.Request, svc ProxyAdminService) {
	rest := strings.TrimPrefix(r.URL.Path, "/console/proxies/")
	proxyID := strings.TrimRight(rest, "/")
	if proxyID == "" {
		WriteError(w, NewError(CodeNotFound, "proxy not found"))
		return
	}

	switch r.Method {
	case http.MethodPatch:
		updateProxyHandler(svc, proxyID)(w, r)
	case http.MethodDelete:
		deleteProxyHandler(svc, proxyID)(w, r)
	default:
		WriteError(w, NewError(CodeMethodNotAllowed, "method not allowed"))
	}
}

func listProxiesHandler(svc ProxyAdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		proxies, err := svc.List(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		if proxies == nil {
			proxies = []consolecontracts.ProxyRecord{}
		}
		WriteData(w, http.StatusOK, proxies)
	}
}

func createProxyHandler(svc ProxyAdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input consolecontracts.ProxyInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		if err := validateProxyInput(input, true); err != nil {
			WriteError(w, err)
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

func updateProxyHandler(svc ProxyAdminService, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input consolecontracts.ProxyInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		if err := validateProxyInput(input, false); err != nil {
			WriteError(w, err)
			return
		}
		record, err := svc.Update(r.Context(), id, input)
		if err != nil {
			WriteError(w, translateProxyError(err))
			return
		}
		WriteData(w, http.StatusOK, record)
	}
}

func deleteProxyHandler(svc ProxyAdminService, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Delete(r.Context(), id); err != nil {
			WriteError(w, translateProxyError(err))
			return
		}
		WriteOK(w)
	}
}

// translateProxyError maps repository sentinel errors to the operator-facing
// envelope. Unknown errors are left untouched so WriteError can apply its
// generic fallback (which prevents raw cause text from leaking).
func translateProxyError(err error) error {
	if err == nil {
		return nil
	}
	if models.IsNotFound(err) {
		return NewError(CodeProxyNotFound, "proxy not found")
	}
	return err
}
