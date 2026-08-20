package app

import (
	"context"
	"strings"
	"testing"

	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/egress"
)

func TestBootstrapRejectsMissingDependencies(t *testing.T) {
	cfg := Config{}.WithDefaults()
	if _, err := buildHandlerWith(cfg, BootstrapDependencies{}); err == nil {
		t.Fatal("missing registry accepted")
	}
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildHandlerWith(cfg, BootstrapDependencies{Registry: registry}); err == nil {
		t.Fatal("missing credential resolver accepted")
	}
	if _, err := providerBaseURLs(nil, nil); err == nil {
		t.Fatal("nil provider registry accepted")
	}
	if _, err := rejectCredential(context.Background(), "provider:openai"); err == nil {
		t.Fatal("unconfigured provider secret accepted")
	}
	_ = egress.CredentialResolver(rejectCredential)
}

func TestProductionBootstrapRejectsSyntheticAccountComposition(t *testing.T) {
	cfg := Config{Environment: "production"}.WithDefaults()
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	_, err = buildHandlerWith(cfg, BootstrapDependencies{
		Registry: registry,
		Credentials: egress.CredentialResolver(func(context.Context, string) (string, error) {
			return "test-key", nil
		}),
	})
	if err == nil || !strings.Contains(err.Error(), "durable account configuration store") {
		t.Fatalf("expected durable account store error, got %v", err)
	}
}
