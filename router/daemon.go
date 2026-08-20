// Package daemon is the single public entry point for the Cartethyia runtime.
package daemon

import (
	"context"
	_ "embed"
	"net/http"
	"time"

	"github.com/cartethyia/daemon/internal/app"
)

//go:embed ascii-carte.html
var healthArtwork string

// Config contains the runtime settings needed to construct Cartethyia.
type Config struct {
	ListenAddress        string
	DashboardDir         string
	DatabaseURL          string
	RedisURL             string
	AccountEncryptionKey string
	Environment          string
	ConsolePassword      string
	TrustProxy           bool

	RequestTimeout      time.Duration
	ReadHeaderTimeout   time.Duration
	ConnectTimeout      time.Duration
	FirstByteTimeout    time.Duration
	IdleTimeout         time.Duration
	StreamIdleTimeout   time.Duration
	StreamTotalTimeout  time.Duration
	ShutdownTimeout     time.Duration
	UsageRetention      time.Duration
	MaxBodyBytes        int
	MaxOutputTokens     int
	MaxConcurrent       int
	MaxConcurrentStream int
}

// LifecycleState is the public lifecycle state reported by Readiness.
type LifecycleState string

const (
	StateStarting LifecycleState = "starting"
	StateReady    LifecycleState = "ready"
	StateDegraded LifecycleState = "degraded"
	StateDraining LifecycleState = "draining"
	StateStopped  LifecycleState = "stopped"
)

// ReadinessSnapshot distinguishes process liveness from request-path readiness.
type ReadinessSnapshot struct {
	State      LifecycleState
	Live       bool
	Ready      bool
	Diagnostic string
}

// Runtime owns the HTTP server and all daemon lifecycle resources.
type Runtime struct {
	inner *app.Runtime
}

// LoadConfig reads daemon configuration from the process environment.
func LoadConfig() (Config, error) {
	loaded, err := app.FromEnvironment()
	if err != nil {
		return Config{}, err
	}
	return Config{
		ListenAddress:        loaded.ListenAddress,
		DashboardDir:         loaded.DashboardDir,
		DatabaseURL:          loaded.DatabaseURL,
		RedisURL:             loaded.RedisURL,
		AccountEncryptionKey: loaded.AccountEncryptionKey,
		Environment:          loaded.Environment,
		ConsolePassword:      loaded.ConsolePassword,
		TrustProxy:           loaded.TrustProxy,
		RequestTimeout:       loaded.RequestTimeout,
		ReadHeaderTimeout:    loaded.ReadHeaderTimeout,
		ConnectTimeout:       loaded.ConnectTimeout,
		FirstByteTimeout:     loaded.FirstByteTimeout,
		IdleTimeout:          loaded.IdleTimeout,
		StreamIdleTimeout:    loaded.StreamIdleTimeout,
		StreamTotalTimeout:   loaded.StreamTotalTimeout,
		ShutdownTimeout:      loaded.ShutdownTimeout,
		UsageRetention:       loaded.UsageRetention,
		MaxBodyBytes:         loaded.MaxBodyBytes,
		MaxOutputTokens:      loaded.MaxOutputTokens,
		MaxConcurrent:        loaded.MaxConcurrent,
		MaxConcurrentStream:  loaded.MaxConcurrentStream,
	}, nil
}
func New(cfg Config) (*Runtime, error) {
	return newRuntime(cfg, healthArtwork)
}

func newRuntime(cfg Config, artwork string) (*Runtime, error) {
	inner, err := app.NewWithHealthArtwork(app.Config{
		ListenAddress:        cfg.ListenAddress,
		DashboardDir:         cfg.DashboardDir,
		DatabaseURL:          cfg.DatabaseURL,
		RedisURL:             cfg.RedisURL,
		AccountEncryptionKey: cfg.AccountEncryptionKey,
		Environment:          cfg.Environment,
		ConsolePassword:      cfg.ConsolePassword,
		TrustProxy:           cfg.TrustProxy,
		RequestTimeout:       cfg.RequestTimeout,
		ReadHeaderTimeout:    cfg.ReadHeaderTimeout,
		ConnectTimeout:       cfg.ConnectTimeout,
		FirstByteTimeout:     cfg.FirstByteTimeout,
		IdleTimeout:          cfg.IdleTimeout,
		StreamIdleTimeout:    cfg.StreamIdleTimeout,
		StreamTotalTimeout:   cfg.StreamTotalTimeout,
		ShutdownTimeout:      cfg.ShutdownTimeout,
		UsageRetention:       cfg.UsageRetention,
		MaxBodyBytes:         cfg.MaxBodyBytes,
		MaxOutputTokens:      cfg.MaxOutputTokens,
		MaxConcurrent:        cfg.MaxConcurrent,
		MaxConcurrentStream:  cfg.MaxConcurrentStream,
	}, artwork)
	if err != nil {
		return nil, err
	}
	return &Runtime{inner: inner}, nil
}

// Handler returns the daemon HTTP handler for embedding or testing.
func (r *Runtime) Handler() http.Handler {
	return r.inner.Handler()
}

// Readiness returns bounded liveness and request-path readiness state.
func (r *Runtime) Readiness() ReadinessSnapshot {
	snapshot := r.inner.Readiness()
	return ReadinessSnapshot{
		State:      LifecycleState(snapshot.State),
		Live:       snapshot.Live,
		Ready:      snapshot.Ready,
		Diagnostic: snapshot.Diagnostic,
	}
}

// Start begins serving HTTP until the context is cancelled or the server fails.
func (r *Runtime) Start(ctx context.Context) error {
	return r.inner.Start(ctx)
}

// Close releases all runtime resources.
func (r *Runtime) Close(ctx context.Context) error {
	return r.inner.Close(ctx)
}
