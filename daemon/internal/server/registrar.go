package server

import (
	"context"
	"net/http"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
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

// AdminRegistrar owns the /console/ route group. The admin packages
// implement this interface; the server consumes only the contract.
type AdminRegistrar interface {
	Registrar
}

// ShareAPIKeyRepository is the durable authority used by public share links.
// Implementations must never return credentials except through Credential,
// which is called only for a validated, one-shot setup link.
type ShareAPIKeyRepository interface {
	GetByID(ctx context.Context, id string) (models.ApiKey, error)
	Credential(ctx context.Context, id string) (string, error)
	GetShareLinkByTokenHash(ctx context.Context, tokenHash string) (models.ShareLink, error)
	ConsumeSetupShareLink(ctx context.Context, id, now string) (models.ShareLink, error)
	TouchShareLink(ctx context.Context, id string) error
}

// ShareUsageSource provides persisted, privacy-safe aggregates for a key.
type ShareUsageSource interface {
	ShareUsage(ctx context.Context, apiKeyID string, now time.Time) (models.ShareUsage, error)
}

// ShareInFlightSource reports the process-wide active request count.
type ShareInFlightSource interface {
	InFlight() int
}

// ShareOptions wires the token-authenticated public share surface.
type ShareOptions struct {
	APIKeys  ShareAPIKeyRepository
	Usage    ShareUsageSource
	InFlight ShareInFlightSource
}

// Options configures NewRouterWith. Registry is required; V1 and Console
// are optional seams. HealthArtwork is operator-facing HTML appended to the
// GET /health response when non-empty.
type Options struct {
	Registry      *observability.Registry
	HealthArtwork string
	DashboardDir  string
	V1            V1Registrar
	// V1Auth wraps the complete /v1 subtree without affecting health or admin.
	V1Auth  func(http.Handler) http.Handler
	Console AdminRegistrar
	Share   *ShareOptions
}
