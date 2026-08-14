package config

import (
	"strings"
	"testing"
	"time"
)

func TestFromEnvironmentDefaults(t *testing.T) {
	for _, key := range []string{
		"CARTETHYIA_LISTEN_ADDRESS", "LISTEN_ADDRESS", "CARTETHYIA_ENV",
		"NODE_ENV", "DATABASE_URL", "CARTETHYIA_DATABASE_URL",
		"CARTETHYIA_REDIS_URL", "REDIS_URL", "CARTETHYIA_REQUEST_TIMEOUT",
		"CARTETHYIA_CONNECT_TIMEOUT", "CARTETHYIA_FIRST_BYTE_TIMEOUT",
		"CARTETHYIA_IDLE_TIMEOUT", "CARTETHYIA_SHUTDOWN_TIMEOUT",
		"CARTETHYIA_USAGE_RETENTION", "CARTETHYIA_MAX_BODY_BYTES",
		"CARTETHYIA_MAX_OUTPUT_TOKENS", "CARTETHYIA_MAX_CONCURRENT",
		"CARTETHYIA_MAX_CONCURRENT_STREAMS",
	} {
		t.Setenv(key, "")
	}

	got, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment: %v", err)
	}
	if got.ListenAddress != ":12800" {
		t.Fatalf("listen address = %q, want %q", got.ListenAddress, ":12800")
	}
	if got.Environment != "development" {
		t.Fatalf("environment = %q, want %q", got.Environment, "development")
	}
	if got.RequestTimeout != 2*time.Minute || got.MaxConcurrent != 256 {
		t.Fatalf("unexpected safe defaults: %#v", got)
	}
}

func TestFromEnvironmentUsesCartethyiaOverrides(t *testing.T) {
	t.Setenv("CARTETHYIA_LISTEN_ADDRESS", ":9090")
	t.Setenv("LISTEN_ADDRESS", ":8080")
	t.Setenv("CARTETHYIA_ENV", "test")
	t.Setenv("NODE_ENV", "production")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("CARTETHYIA_REDIS_URL", "redis://localhost:6379")
	t.Setenv("CARTETHYIA_REQUEST_TIMEOUT", "45s")
	t.Setenv("CARTETHYIA_MAX_BODY_BYTES", "4096")

	got, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment: %v", err)
	}
	if got.ListenAddress != ":9090" || got.DatabaseURL != "postgres://example" ||
		got.RedisURL != "redis://localhost:6379" || got.Environment != "test" ||
		got.RequestTimeout != 45*time.Second || got.MaxBodyBytes != 4096 {
		t.Fatalf("unexpected config = %#v", got)
	}
}

func TestFromEnvironmentRejectsMalformedValues(t *testing.T) {
	t.Setenv("CARTETHYIA_LISTEN_ADDRESS", "localhost")
	if _, err := FromEnvironment(); err == nil {
		t.Fatal("expected malformed listen address error")
	}

	t.Setenv("CARTETHYIA_LISTEN_ADDRESS", ":12800")
	t.Setenv("CARTETHYIA_REQUEST_TIMEOUT", "not-a-duration")
	if _, err := FromEnvironment(); err == nil {
		t.Fatal("expected malformed duration error")
	}
}

func TestConfigValidateRejectsUnsafeBounds(t *testing.T) {
	cfg, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment: %v", err)
	}
	cfg.MaxBodyBytes = maxBodyBytes + 1
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected max body bound error")
	}

	cfg, _ = FromEnvironment()
	cfg.Environment = strings.Repeat("x", 65)
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected environment bound error")
	}
}
