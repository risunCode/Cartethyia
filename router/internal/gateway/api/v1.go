// Package v1 is the composable registration entry point for the Cartethyia
// /v1 API surface. Concrete handlers live in per-endpoint subpackages; this
// file owns the registration helper that wires the route table onto a
// caller-supplied mux.
//
// Design notes:
//
//   - Handlers never import concrete providers or storage. The only
//     dependency is the apicontracts.ProxyService interface that accepts the
//     inbound request context and a normalized contracts.Request, then returns
//     an apicontracts.Stream.
//     Streaming is preserved as an interface so the consumer can copy
//     bytes from the underlying reader into the http.ResponseWriter
//     without the handler knowing the wire format.
//
//   - RegisterV1 never starts a listener. The caller supplies the
//     http.ServeMux; the registration is purely additive.
//
//   - Unhandled subpaths under /v1/ and /v1beta/ fall through to a 404
//     catch-all so the caller gets a consistent error envelope rather than
//     a 404 from the foundation router.
package api

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/router/batch"
	"github.com/cartethyia/daemon/internal/telemetry"
)

// Deps bundles the dependencies RegisterV1 needs. The fields are kept small
// and explicit so wiring remains obvious in the runtime package.
type Deps struct {
	Proxy    ProxyService
	Catalog  ModelCatalog
	Evidence *telemetry.Registry
	Batch    batch.Service
}

// PublicRoute is one concrete method/path pair exposed by the V1 registrar.
// Dynamic Gemini model paths are represented with an OpenAPI-style {model}
// placeholder so the route inventory remains deterministic.
type PublicRoute struct {
	Method string
	Path   string
}

type routeRegistration struct {
	routes   []PublicRoute
	register func(*http.ServeMux, Deps)
}

var publicRouteRegistrations = []routeRegistration{
	{routes: []PublicRoute{
		{Method: http.MethodGet, Path: "/v1/batches"},
		{Method: http.MethodPost, Path: "/v1/batches"},
		{Method: http.MethodGet, Path: "/v1/batches/{batchId}"},
		{Method: http.MethodPost, Path: "/v1/batches/{batchId}/cancel"},
		{Method: http.MethodGet, Path: "/v1/batches/{batchId}/progress"},
	}, register: registerBatch},
	{routes: []PublicRoute{{Method: http.MethodPost, Path: ActionPath}}, register: registerAction},
	{routes: []PublicRoute{{Method: http.MethodPost, Path: ChatPath}}, register: registerChat},
	{routes: []PublicRoute{
		{Method: http.MethodPost, Path: "/v1beta/models/{model}:generateContent"},
		{Method: http.MethodPost, Path: "/v1beta/models/{model}:streamGenerateContent"},
	}, register: registerGemini},
	{routes: []PublicRoute{
		{Method: http.MethodPost, Path: MessagesPath},
		{Method: http.MethodPost, Path: MessagesPath + "/count_tokens"},
	}, register: registerMessages},
	{routes: []PublicRoute{{Method: http.MethodPost, Path: ResponsesPath}}, register: registerResponses},
	{routes: []PublicRoute{
		{Method: http.MethodPost, Path: PathGenerations},
		{Method: http.MethodPost, Path: PathEdits},
	}, register: registerImages},
	{routes: []PublicRoute{{Method: http.MethodGet, Path: ModelsPath}}, register: registerModels},
}

// PublicRoutes returns a copy of the route inventory used by RegisterV1.
func PublicRoutes() []PublicRoute {
	routes := make([]PublicRoute, 0, len(publicRouteRegistrations))
	for _, registration := range publicRouteRegistrations {
		routes = append(routes, registration.routes...)
	}
	return routes
}

// RegisterV1 mounts the /v1 and native Gemini /v1beta route tables on mux. It
// does not start any listener. The function is safe to call once; calling it
// twice will cause the underlying http.ServeMux to panic on duplicate
// registration, which is the desired fail-fast behavior.
func RegisterV1(mux *http.ServeMux, deps Deps) {
	for _, registration := range publicRouteRegistrations {
		registration.register(mux, deps)
	}

	// Catch-all for unknown /v1 subpaths. The foundation router also has
	// its own /v1/ catch-all; whichever pattern is more specific wins, and
	// this catch-all only fires for subpaths that don't match a known
	// endpoint. Keeping a second 404 here gives a stable error envelope
	// even when the foundation router's catch-all is reconfigured.
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		NotFound(w, "no /v1 route registered for "+r.URL.Path)
	})
	mux.HandleFunc("/v1beta/", func(w http.ResponseWriter, r *http.Request) {
		NotFound(w, "no /v1beta route registered for "+r.URL.Path)
	})
}
