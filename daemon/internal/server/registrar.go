package server

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/observability"
)

// Registrar attaches a group of routes to the foundation router.
//
// Implementations live in their own packages and MUST NOT start listeners.
// The contract is intentionally minimal so any http.Handler-producing
// package can satisfy it without coupling to this package's internals.
type Registrar interface {
	Register(mux *http.ServeMux)
}

// V1Registrar owns the /v1/ route group. The v1 packages implement this
// interface so the server stays decoupled from the concrete proxy surface.
type V1Registrar interface {
	Registrar
}

// AdminRegistrar owns the /v2/admin/ route group. The admin packages
// implement this interface; the server consumes only the contract.
type AdminRegistrar interface {
	Registrar
}

// Options configures NewRouterWith. Registry is required; V1 and V2Admin
// are optional seams. HealthArtwork is operator-facing HTML appended to the
// GET /health response when non-empty.
type Options struct {
	Registry      *observability.Registry
	HealthArtwork string
	V1            V1Registrar
	// V1Auth wraps the complete /v1 subtree without affecting health or admin.
	V1Auth  func(http.Handler) http.Handler
	V2Admin AdminRegistrar
}
