package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	serverwire "github.com/cartethyia/daemon/internal/gateway/api"
)

// RuntimeDependency is a narrow lifecycle seam owned by the package that
// provides the dependency. Probes must be bounded and side-effect free.
type RuntimeDependency struct {
	Name       string
	Required   bool
	Probe      Probe
	Invalidate func(context.Context) error
	Close      func(context.Context) error
}

// RuntimeOptions allows tests and composition code to inject optional probes,
// recovery workers, and startup tuning without constructing duplicate clients.
type RuntimeOptions struct {
	Dependencies   []RuntimeDependency
	Workers        []RecoveryWorker
	StartupTimeout time.Duration
}

type dependencyState struct {
	dependency RuntimeDependency
	healthy    bool
	lastError  error
}

// Runtime owns the Go API HTTP server, dependency workers, and lifecycle state.
type Runtime struct {
	server          *http.Server
	lifecycle       *Lifecycle
	serveCancel     context.CancelFunc
	shutdownTimeout time.Duration
	startupTimeout  time.Duration

	depsMu            sync.RWMutex
	dependencies      map[string]*dependencyState
	dependencyOrder   []string
	configuredWorkers []RecoveryWorker
	workers           *RecoveryGroup

	startMu   sync.Mutex
	started   bool
	closeOnce sync.Once
	closeMu   sync.RWMutex
	closeErr  error
}

// New assembles the Go API runtime without opening a listener.
func New(cfg Config) (*Runtime, error) {
	return NewWithHealthArtwork(cfg, "")
}

// NewWithOptions is the injectable composition entry point used by runtime
// tests and embedders that have real provider/account/cache boundaries.
func NewWithOptions(cfg Config, options RuntimeOptions) (*Runtime, error) {
	return newRuntimeWithOptions(cfg, "", options, nil)
}

// NewWithHealthArtwork assembles the runtime and embeds operator-facing health
// artwork into the /health response.
func NewWithHealthArtwork(cfg Config, artwork string) (*Runtime, error) {
	return newRuntimeWithOptions(cfg, artwork, RuntimeOptions{}, nil)
}

// newRuntimeWithBootstrap is used by composition tests to keep bootstrap and
// lifecycle construction in one deterministic path.
func newRuntimeWithBootstrap(cfg Config, artwork string, deps BootstrapDependencies, options RuntimeOptions) (*Runtime, error) {
	return newRuntimeWithOptions(cfg, artwork, options, &deps)
}

func newRuntimeWithOptions(cfg Config, artwork string, options RuntimeOptions, bootstrap *BootstrapDependencies) (*Runtime, error) {
	cfg = cfg.WithDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, runtimeError(CodeDependencyRequired, "config", err)
	}
	var (
		handler  http.Handler
		err      error
		registry *providers.Registry
	)
	if bootstrap == nil {
		var defaults BootstrapDependencies
		defaults, err = defaultBootstrapDependencies(cfg)
		if err != nil {
			return nil, runtimeError(CodeDependencyRequired, "bootstrap", err)
		}
		bootstrap = &defaults
	}
	registry = bootstrap.Registry
	handler, err = buildHandlerWithArtworkAndDependencies(cfg, *bootstrap, artwork)
	if err != nil {
		if bootstrap.MetadataWriter != nil {
			_ = bootstrap.MetadataWriter.Close(context.Background())
		}
		if bootstrap.Database != nil {
			_ = bootstrap.Database.Close(context.Background())
		}
		if bootstrap.Cache != nil {
			_ = bootstrap.Cache.Close()
		}
		return nil, runtimeError(CodeDependencyRequired, "bootstrap", err)
	}
	handler = serverwire.WithStreamDeadlines(handler, cfg.StreamIdleTimeout, cfg.StreamTotalTimeout)
	if options.StartupTimeout <= 0 {
		options.StartupTimeout = cfg.ConnectTimeout
		if options.StartupTimeout <= 0 {
			options.StartupTimeout = cfg.RequestTimeout
		}
	}
	allDeps := append([]RuntimeDependency(nil), options.Dependencies...)
	// Provider registry is mandatory for request-path routing. The probe only
	// validates the already-constructed registry and never performs upstream I/O.
	if registry != nil {
		allDeps = append([]RuntimeDependency{{
			Name:     "provider_registry",
			Required: true,
			Probe:    providerRegistryProbe(registry),
		}}, allDeps...)
	}
	if bootstrap.Database != nil {
		allDeps = append([]RuntimeDependency{{
			Name:     "postgresql",
			Required: true,
			Probe:    bootstrap.Database.Probe,
			Close:    bootstrap.Database.Close,
		}}, allDeps...)
	}
	if bootstrap.MetadataWriter != nil {
		writer := bootstrap.MetadataWriter
		allDeps = append([]RuntimeDependency{{
			Name:     "metadata_writer",
			Required: false,
			Probe:    func(context.Context) error { return nil },
			Close:    writer.Close,
		}}, allDeps...)
	}
	if remote, ok := bootstrap.Cache.(interface{ Probe(context.Context) error }); ok {
		allDeps = append(allDeps, RuntimeDependency{
			Name: "redis", Required: false, Probe: remote.Probe, Close: func(_ context.Context) error { return bootstrap.Cache.Close() },
		})
	}
	if bootstrap.Database != nil && bootstrap.Database.TokenBudget != nil {
		cleaner := bootstrap.Database.TokenBudget
		options.Workers = append(options.Workers, RecoveryWorker{
			Name:         "expired_token_reservations",
			Interval:     time.Minute,
			MaxBackoff:   15 * time.Minute,
			ProbeTimeout: cfg.ConnectTimeout,
			Probe: func(ctx context.Context) error {
				_, err := cleaner.RecoverExpired(ctx, time.Now().UTC(), 0)
				return err
			},
		})
	}
	states := make(map[string]*dependencyState, len(allDeps))
	order := make([]string, 0, len(allDeps))
	for _, dep := range allDeps {
		if dep.Name == "" || dep.Probe == nil {
			return nil, runtimeError(CodeDependencyRequired, "validate", errors.New("dependency name and probe are required"))
		}
		if _, exists := states[dep.Name]; exists {
			return nil, runtimeError(CodeDependencyRequired, "validate", errors.New("dependency names must be unique"))
		}
		states[dep.Name] = &dependencyState{dependency: dep, healthy: true}
		order = append(order, dep.Name)
	}
	serveCtx, serveCancel := context.WithCancel(context.Background())
	return &Runtime{
		server: &http.Server{
			Addr:              cfg.ListenAddress,
			Handler:           handler,
			ReadTimeout:       cfg.RequestTimeout,
			ReadHeaderTimeout: cfg.ReadHeaderTimeout,
			WriteTimeout:      cfg.RequestTimeout,
			IdleTimeout:       cfg.IdleTimeout,
			MaxHeaderBytes:    cfg.MaxHeaderBytes,
			BaseContext: func(net.Listener) context.Context {
				return serveCtx
			},
		},
		lifecycle:         NewLifecycle(),
		serveCancel:       serveCancel,
		shutdownTimeout:   cfg.ShutdownTimeout,
		startupTimeout:    options.StartupTimeout,
		dependencies:      states,
		dependencyOrder:   order,
		configuredWorkers: append([]RecoveryWorker(nil), options.Workers...),
		workers:           NewRecoveryGroup(options.Workers...),
	}, nil
}

func providerRegistryProbe(registry *providers.Registry) Probe {
	return func(ctx context.Context) error {
		if registry == nil {
			return errors.New("provider registry is unavailable")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, id := range registry.IDs() {
			provider, err := registry.Get(id)
			if err != nil {
				return fmt.Errorf("provider %s: %w", id, err)
			}
			if provider == nil || provider.Metadata().ID == "" {
				return fmt.Errorf("provider %s is unavailable", id)
			}
			if provider.Models() == nil {
				return fmt.Errorf("provider %s model catalog is unavailable", id)
			}
		}
		return nil
	}
}

// Handler returns the Go API handler for embedding or testing.
func (r *Runtime) Handler() http.Handler {
	if r == nil || r.server == nil {
		return nil
	}
	return r.server.Handler
}

// Readiness returns bounded liveness and request-path readiness state.
func (r *Runtime) Readiness() ReadinessSnapshot {
	if r == nil || r.lifecycle == nil {
		return ReadinessSnapshot{State: StateStopped}
	}
	return r.lifecycle.Snapshot()
}

func (r *Runtime) warmup(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	warmCtx, cancel := context.WithTimeout(ctx, r.startupTimeout)
	defer cancel()
	r.depsMu.RLock()
	deps := make([]RuntimeDependency, 0, len(r.dependencyOrder))
	for _, name := range r.dependencyOrder {
		deps = append(deps, r.dependencies[name].dependency)
	}
	r.depsMu.RUnlock()
	// Dependencies are inserted in deterministic construction order. The
	// provider registry is first; injected account/cache/auth probes follow.
	for _, dep := range deps {
		if err := warmCtx.Err(); err != nil {
			return runtimeError(CodeStartupCanceled, "warmup", err)
		}
		err := dep.Probe(warmCtx)
		r.recordDependency(dep.Name, err)
	}
	return nil
}

func (r *Runtime) recordDependency(name string, err error) {
	r.depsMu.Lock()
	state := r.dependencies[name]
	if state != nil {
		state.healthy = err == nil
		state.lastError = err
	}
	r.depsMu.Unlock()
}

func (r *Runtime) readinessStatus() (requiredHealthy, optionalHealthy bool, diagnostic string) {
	requiredHealthy, optionalHealthy = true, true
	r.depsMu.RLock()
	degraded := ""
	for _, name := range r.dependencyOrder {
		state := r.dependencies[name]
		if state != nil && !state.healthy {
			if state.dependency.Required {
				requiredHealthy = false
			}
			optionalHealthy = false
			if degraded == "" {
				degraded = name + " unavailable"
			}
		}
	}
	r.depsMu.RUnlock()
	return requiredHealthy, optionalHealthy, degraded
}

func (r *Runtime) publishReadiness() {
	requiredHealthy, optionalHealthy, diagnostic := r.readinessStatus()
	if !requiredHealthy || !optionalHealthy {
		_ = r.lifecycle.Transition(StateDegraded, diagnostic)
		return
	}
	_ = r.lifecycle.Transition(StateReady, "")
}

func (r *Runtime) dependencyWorker(dep RuntimeDependency) RecoveryWorker {
	return RecoveryWorker{
		Name:       dep.Name,
		Probe:      dep.Probe,
		Interval:   time.Second,
		MaxBackoff: time.Minute,
		Eligible: func() bool {
			return true
		},
		Invalidate: dep.Invalidate,
		OnSuccess: func() {
			r.recordDependency(dep.Name, nil)
			r.publishReadiness()
		},
		OnFailure: func(err error) {
			r.recordDependency(dep.Name, err)
			r.publishReadiness()
		},
	}
}

func (r *Runtime) startWorkers(ctx context.Context, supplied []RecoveryWorker) error {
	r.depsMu.RLock()
	deps := make([]RuntimeDependency, 0, len(r.dependencyOrder))
	for _, name := range r.dependencyOrder {
		deps = append(deps, r.dependencies[name].dependency)
	}
	r.depsMu.RUnlock()
	workers := make([]RecoveryWorker, 0, len(deps)+len(supplied))
	for _, dep := range deps {
		workers = append(workers, r.dependencyWorker(dep))
	}
	workers = append(workers, supplied...)
	if len(workers) == 0 {
		return nil
	}
	r.workers = NewRecoveryGroup(workers...)
	return r.workers.Start(ctx)
}

// Start serves the Go API until context cancellation or a server failure. It
// warms mandatory and optional dependencies before publishing readiness.
func (r *Runtime) Start(ctx context.Context) error {
	if r == nil {
		return runtimeError(CodeAlreadyStarted, "start", errors.New("nil runtime"))
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.startMu.Lock()
	if r.started {
		r.startMu.Unlock()
		return runtimeError(CodeAlreadyStarted, "start", errors.New("runtime already started"))
	}
	r.started = true
	r.startMu.Unlock()
	if err := r.warmup(ctx); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		_ = r.lifecycle.Transition(StateDegraded, "startup warmup failed")
	}
	if err := r.startWorkers(ctx, r.configuredWorkers); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return r.Close(context.Background())
	}
	requiredHealthy, _, diagnostic := r.readinessStatus()
	if !requiredHealthy {
		_ = r.lifecycle.Transition(StateDegraded, diagnostic)
		return runtimeError(CodeDependencyRequired, "startup readiness", errors.New(diagnostic))
	}
	r.publishReadiness()
	errorsCh := make(chan error, 1)
	go func() {
		err := r.server.ListenAndServe()
		if !errors.Is(err, http.ErrServerClosed) {
			errorsCh <- runtimeError(CodeServer, "listen", err)
		}
	}()
	select {
	case err := <-errorsCh:
		_ = r.lifecycle.Transition(StateDegraded, "http listener failed")
		return err
	case <-ctx.Done():
		return r.Close(context.Background())
	}
}

// Close gracefully stops workers, the HTTP server, and injected dependencies
// under one bounded shutdown deadline. It is idempotent.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.closeOnce.Do(func() {
		if err := r.lifecycle.Transition(StateDraining, "shutdown requested"); err != nil {
			r.closeMu.Lock()
			r.closeErr = err
			r.closeMu.Unlock()
			return
		}
		if r.serveCancel != nil {
			r.serveCancel()
		}
		shutdownCtx, cancel := context.WithTimeout(ctx, r.shutdownTimeout)
		defer cancel()
		var firstErr error
		if r.workers != nil {
			firstErr = r.workers.Close(shutdownCtx)
		}
		if err := r.server.Shutdown(shutdownCtx); err != nil && firstErr == nil {
			if errors.Is(err, context.DeadlineExceeded) {
				firstErr = runtimeError(CodeShutdownDeadline, "server", err)
			} else {
				firstErr = runtimeError(CodeServer, "shutdown", err)
			}
		}
		r.depsMu.RLock()
		deps := make([]RuntimeDependency, 0, len(r.dependencyOrder))
		for _, name := range r.dependencyOrder {
			deps = append(deps, r.dependencies[name].dependency)
		}
		r.depsMu.RUnlock()
		for _, dep := range deps {
			if dep.Close == nil {
				continue
			}
			if err := dep.Close(shutdownCtx); err != nil && firstErr == nil {
				if errors.Is(err, context.DeadlineExceeded) {
					firstErr = runtimeError(CodeShutdownDeadline, "close "+dep.Name, err)
				} else {
					firstErr = runtimeError(CodeDependencyProbe, "close "+dep.Name, err)
				}
			}
		}
		if firstErr == nil {
			firstErr = r.lifecycle.Transition(StateStopped, "")
		}
		r.closeMu.Lock()
		r.closeErr = firstErr
		r.closeMu.Unlock()
	})
	r.closeMu.RLock()
	defer r.closeMu.RUnlock()
	return r.closeErr
}
