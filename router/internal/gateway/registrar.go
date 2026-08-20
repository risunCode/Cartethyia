package gateway

import (
	"net/http"

	"github.com/cartethyia/daemon/internal/telemetry"
)

// Registrar attaches a group of routes to the gateway router.
//
// Implementations live in their own packages and MUST NOT start listeners.
// The contract is intentionally minimal so any http.Handler-producing
// package can satisfy it without coupling to this package's internals.
type Registrar interface {
	Register(mux *http.ServeMux)
}

// V1Registrar owns the /v1/ route group. The v1 packages implement this
// interface so the gateway stays decoupled from the concrete proxy surface.
type V1Registrar interface {
	Registrar
}

// AdminRegistrar owns the /console/ route group. The admin packages
// implement this interface; the gateway consumes only the contract.
type AdminRegistrar interface {
	Registrar
}

// Options configures NewRouterWith. Registry is required; V1 and Console
// are optional seams. HealthArtwork is operator-facing HTML appended to the
// GET /health response when non-empty.
type Options struct {
	Registry      *telemetry.Registry
	HealthArtwork string
	DashboardDir  string
	V1            V1Registrar
	// V1Auth wraps the complete /v1 subtree without affecting health or admin.
	V1Auth  func(http.Handler) http.Handler
	Console AdminRegistrar
}
