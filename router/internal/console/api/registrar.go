package api

import (
	"context"
	"net/http"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
)

// AdminRegistrar is the narrow host registration seam consumed by the gateway.
// Console owns the concrete routes; the gateway only knows how to mount them.
type AdminRegistrar interface {
	Register(*http.ServeMux)
}

// ShareAPIKeyRepository is the bounded repository seam used by public share
// links. Credentials are only read after a validated, one-shot setup link.
type ShareAPIKeyRepository interface {
	GetByID(context.Context, string) (models.ApiKey, error)
	Credential(context.Context, string) (string, error)
	GetShareLinkByTokenHash(context.Context, string) (models.ShareLink, error)
	ConsumeSetupShareLink(context.Context, string, string) (models.ShareLink, error)
	TouchShareLink(context.Context, string) error
}

type ShareUsageSource interface {
	ShareUsage(context.Context, string, time.Time) (models.ShareUsage, error)
}

type ShareInFlightSource interface {
	InFlight() int
}

// ShareOptions wires the token-authenticated public share surface.
type ShareOptions struct {
	APIKeys  ShareAPIKeyRepository
	Usage    ShareUsageSource
	InFlight ShareInFlightSource
}

// Registrar composes the console API and public share routes behind the
// gateway's narrow registration port.
type Registrar struct {
	Services Services
	Share    *ShareOptions
}

func NewRegistrar(services Services, share *ShareOptions) *Registrar {
	return &Registrar{Services: services, Share: share}
}

func (r *Registrar) Register(mux *http.ServeMux) {
	if r == nil || mux == nil {
		return
	}
	Register(mux, r.Services)
	RegisterShare(mux, r.Share)
}

// RegisterShare mounts the preserved /share/* public routes.
func RegisterShare(mux *http.ServeMux, opts *ShareOptions) {
	registerShare(mux, opts)
}
