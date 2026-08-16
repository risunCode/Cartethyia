package daemon_test

import (
	"context"
	"strings"
	"testing"

	"github.com/cartethyia/daemon"
)

func TestLoadConfigDefaultsAndValidation(t *testing.T) {
	for _, name := range []string{
		"CARTETHYIA_LISTEN_ADDRESS", "LISTEN_ADDRESS", "CARTETHYIA_DATABASE_URL", "DATABASE_URL",
		"CARTETHYIA_REDIS_URL", "REDIS_URL", "CARTETHYIA_ENCRYPTION_KEY", "CARTETHYIA_ACCOUNT_ENCRYPTION_KEY",
		"ACCOUNT_ENCRYPTION_KEY", "CARTETHYIA_ENV", "NODE_ENV",
	} {
		t.Setenv(name, "")
	}

	cfg, err := daemon.LoadConfig()
	if err != nil {
		t.Fatalf("load default config: %v", err)
	}
	if cfg.ListenAddress == "" || cfg.Environment == "" || cfg.RequestTimeout <= 0 || cfg.MaxBodyBytes <= 0 {
		t.Fatalf("default config has missing values: %#v", cfg)
	}

	t.Setenv("CARTETHYIA_REQUEST_TIMEOUT", "not-a-duration")
	if _, err := daemon.LoadConfig(); err == nil {
		t.Fatal("load config with invalid duration succeeded")
	}
}

func TestRuntimeCloseWithoutStart(t *testing.T) {
	runtime, err := daemon.New(daemon.Config{ListenAddress: ":0"})
	if err != nil {
		t.Fatalf("new runtime: %v", err)
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestDiagnosticWrappersRejectInvalidConfig(t *testing.T) {
	cfg := daemon.Config{ListenAddress: "not-a-listen-address"}

	if _, err := daemon.Doctor(nil, cfg); err == nil || !strings.Contains(err.Error(), "diagnostics: config") {
		t.Fatalf("doctor error = %v, want config validation error", err)
	}
	if _, err := daemon.ExplainRoute(nil, cfg, "model", "chat"); err == nil || !strings.Contains(err.Error(), "diagnostics: config") {
		t.Fatalf("explain route error = %v, want config validation error", err)
	}
	if _, err := daemon.Readiness(nil, cfg, "model"); err == nil || !strings.Contains(err.Error(), "diagnostics: config") {
		t.Fatalf("readiness error = %v, want config validation error", err)
	}
}


