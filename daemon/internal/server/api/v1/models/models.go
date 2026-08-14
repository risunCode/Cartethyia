// Package models owns GET /v1/models. It serves a stable snapshot of the
// model catalog and never touches the proxy pipeline. Non-standard HTTP
// methods are rejected with 405 so the daemon exposes only standard methods.
package models

import (
	"encoding/json"
	"net/http"

	"github.com/cartethyia/daemon/internal/server/api/contracts"
	"github.com/cartethyia/daemon/internal/server/api/errors"
)

// Path is the canonical /v1 path for the model catalog.
const Path = "/v1/models"

// Entry is the per-model wire shape returned in the catalog list response.
// It deliberately matches the OpenAI /v1/models entry shape so client SDKs
// can consume the response without a Cartethyia-specific parser.
type Entry struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	OwnedBy string `json:"owned_by"`
}

// ListResponse is the wire envelope returned by GET /v1/models.
type ListResponse struct {
	Object string  `json:"object"`
	Data   []Entry `json:"data"`
}

// Deps wires the models handler to the catalog snapshot.
type Deps struct {
	Catalog apicontracts.ModelCatalog
}

// Register mounts GET /v1/models on mux.
func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(Path, func(w http.ResponseWriter, r *http.Request) {
		handle(w, r, deps.Catalog)
	})
}

func handle(w http.ResponseWriter, r *http.Request, catalog apicontracts.ModelCatalog) {
	if r.Method != http.MethodGet {
		apierrors.MethodNotAllowed(w, http.MethodGet)
		return
	}
	if catalog == nil {
		apierrors.Write(w, http.StatusServiceUnavailable, apierrors.CodeInternal, "model catalog is not configured")
		return
	}

	accounts, err := catalog.List()
	if err != nil {
		apierrors.WriteError(w, err)
		return
	}

	entries := make([]Entry, 0, len(accounts))
	for _, account := range accounts {
		if !account.Enabled {
			continue
		}
		entries = append(entries, Entry{
			ID:      account.ID,
			Object:  "model",
			OwnedBy: account.Provider,
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(ListResponse{Object: "list", Data: entries})
}
