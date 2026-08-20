package gateway

import (
	"net/http"

	v1 "github.com/cartethyia/daemon/internal/gateway/api"
)

// PublicRoute is one concrete method/path pair in the public gateway surface.
// Dynamic paths use an OpenAPI-style placeholder.
type PublicRoute struct {
	Method string
	Path   string
}

// PublicRouteInventory returns the active public routes mounted by the
// gateway's built-in handlers and V1 registrar. The returned slice is a fresh
// copy so contract checks cannot mutate the registration authority.
func PublicRouteInventory() []PublicRoute {
	routes := []PublicRoute{
		{Method: http.MethodGet, Path: "/health"},
		{Method: http.MethodGet, Path: "/metrics"},
	}
	for _, route := range v1.PublicRoutes() {
		routes = append(routes, PublicRoute{
			Method: route.Method,
			Path:   route.Path,
		})
	}
	return routes
}
