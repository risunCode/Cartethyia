package app

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
		"CARTETHYIA_READ_HEADER_TIMEOUT", "CARTETHYIA_MAX_HEADER_BYTES",
		"CARTETHYIA_CONNECT_TIMEOUT", "CARTETHYIA_FIRST_BYTE_TIMEOUT",
		"CARTETHYIA_IDLE_TIMEOUT", "CARTETHYIA_SHUTDOWN_TIMEOUT",
		"CARTETHYIA_STREAM_IDLE_TIMEOUT", "CARTETHYIA_STREAM_TOTAL_TIMEOUT",
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
	if got.ReadHeaderTimeout != 10*time.Second || got.MaxHeaderBytes != 1<<20 {
		t.Fatalf("unexpected header defaults: timeout=%s bytes=%d", got.ReadHeaderTimeout, got.MaxHeaderBytes)
	}
	if got.StreamIdleTimeout != got.IdleTimeout || got.StreamTotalTimeout != got.RequestTimeout {
		t.Fatalf("stream defaults are not derived from request budgets: %#v", got)
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
	t.Setenv("CARTETHYIA_READ_HEADER_TIMEOUT", "7s")
	t.Setenv("CARTETHYIA_MAX_HEADER_BYTES", "131072")
	t.Setenv("CARTETHYIA_STREAM_IDLE_TIMEOUT", "12s")
	t.Setenv("CARTETHYIA_STREAM_TOTAL_TIMEOUT", "3m")
	t.Setenv("CARTETHYIA_MAX_BODY_BYTES", "4096")

	got, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment: %v", err)
	}
	if got.ListenAddress != ":9090" || got.DatabaseURL != "postgres://example" ||
		got.RedisURL != "redis://localhost:6379" || got.Environment != "test" ||
		got.RequestTimeout != 45*time.Second || got.ReadHeaderTimeout != 7*time.Second ||
		got.MaxHeaderBytes != 131072 || got.StreamIdleTimeout != 12*time.Second ||
		got.StreamTotalTimeout != 3*time.Minute || got.MaxBodyBytes != 4096 {
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

	t.Setenv("CARTETHYIA_REQUEST_TIMEOUT", "45s")
	t.Setenv("CARTETHYIA_TRUST_PROXY", "not-a-bool")
	if _, err := FromEnvironment(); err == nil {
		t.Fatal("expected malformed trust proxy error")
	}
}

func TestFromEnvironmentTrustProxy(t *testing.T) {
	t.Setenv("CARTETHYIA_TRUST_PROXY", "")
	if got, err := FromEnvironment(); err != nil || got.TrustProxy {
		t.Fatalf("default must be untrusted: got=%v err=%v", got.TrustProxy, err)
	}
	if TrustProxyFromEnvironment() {
		t.Fatal("TrustProxyFromEnvironment default must be false")
	}

	t.Setenv("CARTETHYIA_TRUST_PROXY", "true")
	got, err := FromEnvironment()
	if err != nil {
		t.Fatalf("FromEnvironment: %v", err)
	}
	if !got.TrustProxy || !TrustProxyFromEnvironment() {
		t.Fatal("trust proxy must parse true")
	}

	t.Setenv("CARTETHYIA_TRUST_PROXY", "0")
	if got, err := FromEnvironment(); err != nil || got.TrustProxy {
		t.Fatalf("explicit false must stay untrusted: got=%v err=%v", got.TrustProxy, err)
	}

	t.Setenv("CARTETHYIA_TRUST_PROXY", "garbage")
	if TrustProxyFromEnvironment() {
		t.Fatal("malformed value must fail closed")
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

func TestConfigValidateRejectsUnsafeHeaderAndStreamTimeouts(t *testing.T) {
	cfg := Config{}.WithDefaults()
	cfg.ReadHeaderTimeout = cfg.RequestTimeout + time.Nanosecond
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "read header timeout") {
		t.Fatalf("Validate error=%v, want read-header bound", err)
	}

	cfg = Config{}.WithDefaults()
	cfg.MaxHeaderBytes = minHeaderBytes - 1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "max header bytes") {
		t.Fatalf("Validate error=%v, want max-header lower bound", err)
	}

	cfg = Config{}.WithDefaults()
	cfg.MaxHeaderBytes = maxHeaderBytes + 1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "max header bytes") {
		t.Fatalf("Validate error=%v, want max-header upper bound", err)
	}

	cfg = Config{}.WithDefaults()
	cfg.StreamIdleTimeout = -time.Nanosecond
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "stream idle timeout") {
		t.Fatalf("Validate error=%v, want stream-idle bound", err)
	}

	cfg = Config{}.WithDefaults()
	cfg.StreamTotalTimeout = maxDuration + time.Nanosecond
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "stream total timeout") {
		t.Fatalf("Validate error=%v, want stream-total bound", err)
	}
}
