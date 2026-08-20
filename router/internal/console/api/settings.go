package api

import (
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"net/http"
)

// RegisterSettings wires /console/settings routes.
func RegisterSettings(mux *http.ServeMux, services Services) {
	if services.Settings == nil {
		return
	}
	set := services.Settings

	mux.HandleFunc("/console/settings", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:   getSettingsHandler(set),
		http.MethodPatch: patchSettingsHandler(set),
		http.MethodPost:  resetSettingsHandler(set),
	}))
}

func getSettingsHandler(svc SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings, err := svc.Get(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}
}

func patchSettingsHandler(svc SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input consolecontracts.RuntimeSettingsInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		settings, err := svc.Patch(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}
}

func resetSettingsHandler(svc SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings, err := svc.Reset(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, settings)
	}
}
