package daemon

import (
	"context"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	internalruntime "github.com/cartethyia/daemon/internal/runtime"
)

type DiagnosticCheck = internalruntime.DiagnosticCheck
type DoctorReport = internalruntime.DoctorReport
type RouteCandidateDiagnostic = internalruntime.RouteCandidateDiagnostic
type RouteExclusionDiagnostic = internalruntime.RouteExclusionDiagnostic
type ProxyDiagnostic = internalruntime.ProxyDiagnostic
type RouteExplanation = internalruntime.RouteExplanation
type ReadinessCandidateDiagnostic = internalruntime.ReadinessCandidateDiagnostic
type ReadinessReport = internalruntime.ReadinessReport

// Doctor performs bounded, non-billable validation of configured runtime
// authorities. It does not construct a provider request or resolve secrets.
func Doctor(ctx context.Context, cfg Config) (DoctorReport, error) {
	return internalruntime.Doctor(ctx, diagnosticRuntimeConfig(cfg))
}

// ExplainRoute builds the canonical catalog route plan from immutable durable
// metadata. It does not acquire an account/proxy lease or change health state.
func ExplainRoute(ctx context.Context, cfg Config, model, surface string) (RouteExplanation, error) {
	return internalruntime.ExplainRoute(ctx, diagnosticRuntimeConfig(cfg), model, contracts.Surface(surface))
}

// Readiness returns an immutable, credential-free account readiness view.
// It never acquires, refreshes, resolves, or probes an account.
func Readiness(ctx context.Context, cfg Config, model string) (ReadinessReport, error) {
	return internalruntime.Readiness(ctx, diagnosticRuntimeConfig(cfg), model)
}

func diagnosticRuntimeConfig(cfg Config) internalruntime.Config {
	return internalruntime.Config{
		ListenAddress:        cfg.ListenAddress,
		DatabaseURL:          cfg.DatabaseURL,
		RedisURL:             cfg.RedisURL,
		AccountEncryptionKey: cfg.AccountEncryptionKey,
		Environment:          cfg.Environment,
		RequestTimeout:       cfg.RequestTimeout,
		ConnectTimeout:       cfg.ConnectTimeout,
		FirstByteTimeout:     cfg.FirstByteTimeout,
		IdleTimeout:          cfg.IdleTimeout,
		ShutdownTimeout:      cfg.ShutdownTimeout,
		UsageRetention:       cfg.UsageRetention,
		MaxBodyBytes:         cfg.MaxBodyBytes,
		MaxOutputTokens:      cfg.MaxOutputTokens,
		MaxConcurrent:        cfg.MaxConcurrent,
		MaxConcurrentStream:  cfg.MaxConcurrentStream,
	}
}
