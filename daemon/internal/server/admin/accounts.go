package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// RegisterAccounts wires account/quota/OAuth lifecycle routes under
// /console/accounts/* and /console/providers/*/accounts/*.
func RegisterAccounts(mux *http.ServeMux, services Services) {
	if services.Accounts == nil {
		return
	}
	acct := services.Accounts

	// Cross-provider account endpoints.
	mux.HandleFunc("/console/accounts", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet: listAccounts(acct),
	}))
	mux.HandleFunc("/console/accounts/", func(w http.ResponseWriter, r *http.Request) {
		handleAccountSubresource(w, r, acct)
	})

	// Provider-scoped account endpoints.
	mux.HandleFunc("/console/providers/", func(w http.ResponseWriter, r *http.Request) {
		handleProviderAccounts(w, r, acct)
	})
}

func handleAccountSubresource(w http.ResponseWriter, r *http.Request, svc AccountService) {
	rest := strings.TrimPrefix(r.URL.Path, "/console/accounts/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		WriteError(w, NewError(CodeNotFound, "account not found"))
		return
	}

	accountID := parts[0]
	tail := parts[1:]

	switch {
	case len(tail) == 0:
		switch r.Method {
		case http.MethodPatch:
			var input AccountInput
			if err := decodeJSON(r, &input); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			record, err := svc.Update(r.Context(), "", accountID, input)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, record)
		case http.MethodDelete:
			if err := svc.Delete(r.Context(), "", accountID); err != nil {
				WriteError(w, err)
				return
			}
			WriteStatus(w, http.StatusNoContent)
		default:
			writeMethodNotAllowed(w, http.MethodPatch, http.MethodDelete)
		}
	case len(tail) == 1 && tail[0] == "quota":
		switch r.Method {
		case http.MethodGet:
			state, err := svc.Quota(r.Context(), accountID)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, state)
		case http.MethodPost:
			state, err := svc.RefreshQuota(r.Context(), accountID)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, state)
		default:
			writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
	default:
		WriteError(w, NewError(CodeNotFound, "account subresource not found"))
	}
}

func handleProviderAccounts(w http.ResponseWriter, r *http.Request, svc AccountService) {
	rest := strings.TrimPrefix(r.URL.Path, "/console/providers/")
	parts := strings.Split(rest, "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] != "accounts" {
		WriteError(w, NewError(CodeNotFound, "provider route not found"))
		return
	}
	providerID := parts[0]
	tail := parts[2:]

	switch {
	case len(tail) == 0:
		switch r.Method {
		case http.MethodGet:
			items, err := svc.List(r.Context(), providerID)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			var input AccountInput
			if err := decodeJSON(r, &input); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			created, err := svc.Create(r.Context(), providerID, input)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusCreated, created)
		default:
			writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
	case len(tail) == 1 && tail[0] == "batch":
		switch r.Method {
		case http.MethodPost:
			var body struct {
				Items []AccountInput `json:"items"`
			}
			if err := decodeJSON(r, &body); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			created, err := svc.BatchCreate(r.Context(), providerID, body.Items)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusCreated, map[string]any{"items": created})
		case http.MethodPatch:
			var body struct {
				Items []AccountBatchPatch `json:"items"`
			}
			if err := decodeJSON(r, &body); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			result, err := svc.BatchUpdate(r.Context(), providerID, body.Items)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, result)
		default:
			writeMethodNotAllowed(w, http.MethodPost, http.MethodPatch)
		}
	case len(tail) == 1 && tail[0] == "batch-delete":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		var body struct {
			Items []string `json:"items"`
		}
		if err := decodeJSON(r, &body); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := svc.BatchDelete(r.Context(), providerID, body.Items)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	case len(tail) == 1:
		// /providers/:id/accounts/:accountId
		accountID := tail[0]
		switch r.Method {
		case http.MethodPost:
			var input AccountInput
			if err := decodeJSON(r, &input); err != nil {
				WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
				return
			}
			updated, err := svc.Update(r.Context(), providerID, accountID, input)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, updated)
		case http.MethodDelete:
			if err := svc.Delete(r.Context(), providerID, accountID); err != nil {
				WriteError(w, err)
				return
			}
			WriteStatus(w, http.StatusNoContent)
		default:
			writeMethodNotAllowed(w, http.MethodPost, http.MethodDelete)
		}
	case len(tail) == 2 && tail[0] != "" && tail[1] == "revoke":
		accountID := tail[0]
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		if err := svc.RevokeForProvider(r.Context(), providerID, accountID); err != nil {
			WriteError(w, err)
			return
		}
		WriteOK(w)
	default:
		WriteError(w, NewError(CodeNotFound, "provider account route not found"))
	}
}

func listAccounts(svc AccountService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		providerID := r.URL.Query().Get("providerId")
		items, err := svc.List(r.Context(), providerID)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"items": items})
	}
}
func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain one JSON value")
		}
		return err
	}
	return validateAdminPayload(dst)
}
