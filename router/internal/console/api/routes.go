package api

import "net/http"

// ConsoleRoute identifies one active console or share method/path pair. Paths
// use OpenAPI-style placeholders for dynamic identifiers.
type ConsoleRoute struct {
	Method string
	Path   string
}

// ConsoleRouteInventory is the single route inventory used by the console
// OpenAPI parity check. Keep this list synchronized with Register and
// RegisterShare; it intentionally contains no endpoint that is not mounted.
func ConsoleRouteInventory() []ConsoleRoute {
	return []ConsoleRoute{
		{http.MethodGet, "/console/dashboard"},
		{http.MethodGet, "/console/accounts"},
		{http.MethodPatch, "/console/accounts/{accountId}"},
		{http.MethodDelete, "/console/accounts/{accountId}"},
		{http.MethodGet, "/console/accounts/{accountId}/quota"},
		{http.MethodPost, "/console/accounts/{accountId}/quota"},
		{http.MethodGet, "/console/providers/{providerId}/accounts"},
		{http.MethodPost, "/console/providers/{providerId}/accounts"},
		{http.MethodPost, "/console/providers/{providerId}/accounts/batch"},
		{http.MethodPatch, "/console/providers/{providerId}/accounts/batch"},
		{http.MethodPost, "/console/providers/{providerId}/accounts/batch-delete"},
		{http.MethodPost, "/console/providers/{providerId}/accounts/{accountId}"},
		{http.MethodDelete, "/console/providers/{providerId}/accounts/{accountId}"},
		{http.MethodPost, "/console/providers/{providerId}/accounts/{accountId}/revoke"},
		{http.MethodGet, "/console/proxies"},
		{http.MethodPost, "/console/proxies"},
		{http.MethodPatch, "/console/proxies/{proxyId}"},
		{http.MethodDelete, "/console/proxies/{proxyId}"},
		{http.MethodGet, "/console/settings"},
		{http.MethodPatch, "/console/settings"},
		{http.MethodPost, "/console/settings"},
		{http.MethodPost, "/console/auth/login"},
		{http.MethodPost, "/console/auth/logout"},
		{http.MethodGet, "/console/auth/session"},
		{http.MethodPost, "/console/auth/refresh"},
		{http.MethodPost, "/console/auth/oauth/start"},
		{http.MethodGet, "/console/auth/oauth/sessions/{sessionId}"},
		{http.MethodGet, "/console/auth/oauth/sessions/{sessionId}/status"},
		{http.MethodPost, "/console/auth/oauth/sessions/{sessionId}/complete"},
		{http.MethodPost, "/console/auth/oauth/sessions/{sessionId}/cancel"},
		{http.MethodPost, "/console/auth/oauth/refresh"},
		{http.MethodPost, "/console/auth/oauth/reauth"},
		{http.MethodGet, "/console/telemetry/in-flight/stream"},
		{http.MethodGet, "/console/telemetry/overview"},
		{http.MethodGet, "/console/telemetry/requests"},
		{http.MethodGet, "/console/telemetry/requests/{requestId}"},
		{http.MethodGet, "/console/telemetry/errors"},
		{http.MethodGet, "/console/telemetry/upstream"},
		{http.MethodGet, "/console/telemetry/usage"},
		{http.MethodGet, "/console/telemetry/clients"},
		{http.MethodGet, "/console/logs"},
		{http.MethodPost, "/console/client-errors"},
		{http.MethodGet, "/console/logs/stream"},
		{http.MethodGet, "/console/catalog/providers"},
		{http.MethodPost, "/console/batches"},
		{http.MethodGet, "/console/batches"},
		{http.MethodGet, "/console/batches/{batchId}"},
		{http.MethodPost, "/console/batches/{batchId}/cancel"},
		{http.MethodGet, "/console/batches/{batchId}/progress"},
		{http.MethodGet, "/share/setup/{token}"},
		{http.MethodGet, "/share/{token}/data"},
		{http.MethodGet, "/share/{token}/stream"},
	}
}
