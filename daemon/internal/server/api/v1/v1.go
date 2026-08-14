// Package v1 is the composable registration entry point for the Cartethyia
// /v1 API surface. Concrete handlers live in per-endpoint subpackages; this
// file owns the registration helper that wires the route table onto a
// caller-supplied mux.
//
// Design notes:
//
//   - Handlers never import concrete providers or storage. The only
//     dependency is the apicontracts.ProxyService interface that accepts a
//     normalized contracts.Request and returns an apicontracts.Stream.
//     Streaming is preserved as an interface so the consumer can copy
//     bytes from the underlying reader into the http.ResponseWriter
//     without the handler knowing the wire format.
//
//   - RegisterV1 never starts a listener. The caller supplies the
//     http.ServeMux; the registration is purely additive.
//
//   - Unhandled subpaths under /v1/ fall through to a 404 catch-all so the
//     caller gets a consistent error envelope rather than a 404 from the
//     foundation router.
package v1

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/server/api/contracts"
	"github.com/cartethyia/daemon/internal/server/api/errors"
	"github.com/cartethyia/daemon/internal/server/api/v1/action"
	"github.com/cartethyia/daemon/internal/server/api/v1/chat"
	"github.com/cartethyia/daemon/internal/server/api/v1/images"
	"github.com/cartethyia/daemon/internal/server/api/v1/messages"
	"github.com/cartethyia/daemon/internal/server/api/v1/models"
	"github.com/cartethyia/daemon/internal/server/api/v1/responses"
)

// Deps bundles the dependencies RegisterV1 needs. The fields are kept small
// and explicit so wiring remains obvious in the runtime package.
type Deps struct {
	Proxy    apicontracts.ProxyService
	Catalog  apicontracts.ModelCatalog
	Evidence *observability.Registry
}

// RegisterV1 mounts the /v1 route table on mux. It does not start any
// listener. The function is safe to call once; calling it twice will cause
// the underlying http.ServeMux to panic on duplicate registration, which is
// the desired fail-fast behavior.
func RegisterV1(mux *http.ServeMux, deps Deps) {
	action.Register(mux, action.Deps{Proxy: deps.Proxy, Evidence: deps.Evidence})
	chat.Register(mux, chat.Deps{Proxy: deps.Proxy})
	messages.Register(mux, messages.Deps{Proxy: deps.Proxy})
	responses.Register(mux, responses.Deps{Proxy: deps.Proxy})
	models.Register(mux, models.Deps{Catalog: deps.Catalog})
	images.Register(mux, images.Deps{Proxy: deps.Proxy})

	// Catch-all for unknown /v1 subpaths. The foundation router also has
	// its own /v1/ catch-all; whichever pattern is more specific wins, and
	// this catch-all only fires for subpaths that don't match a known
	// endpoint. Keeping a second 404 here gives a stable error envelope
	// even when the foundation router's catch-all is reconfigured.
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		apierrors.NotFound(w, "no /v1 route registered for "+r.URL.Path)
	})
}
