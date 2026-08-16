package admin

import "net/http"

// Register wires every admin surface under the given mux. It is the single
// composable entry point; callers pass in a populated Services aggregate and
// obtain a fully routed handler. The function never starts a listener and
// never touches storage, provider, or proxy globals.
//
// Each subpackage function is safe to call independently so callers can mount
// only the slices they need (e.g. to keep read-only deployments slim).
func Register(mux *http.ServeMux, services Services) {
	internal := http.NewServeMux()
	RegisterDashboard(internal, services)
	RegisterAccounts(internal, services)
	RegisterSettings(internal, services)
	RegisterAuth(internal, services)
	RegisterTelemetry(internal, services)
	RegisterConsole(internal, services)
	RegisterCatalog(internal, services)
	RegisterUsage(internal, services)
	mux.Handle("/console/", scopedAdmin(services, internal))
}
