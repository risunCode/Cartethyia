package admin

import "net/http"

// RegisterDashboard wires the dashboard summary routes onto the given mux.
// The dashboard is a read-only surface that fronts the rest of the admin.
func RegisterDashboard(mux *http.ServeMux, services Services) {
	mux.HandleFunc("/console/dashboard", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		summary, err := services.Dashboard.Summary(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, summary)
	}))
}
