package runtime

import (
	"context"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/config"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/proxy/transport"
)

func TestBootstrapRejectsMissingDependencies(t *testing.T) {
	cfg := config.Config{}.WithDefaults()
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
	_ = transport.CredentialResolver(rejectCredential)
}

func TestProductionBootstrapRejectsSyntheticAccountComposition(t *testing.T) {
	cfg := config.Config{Environment: "production"}.WithDefaults()
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	_, err = buildHandlerWith(cfg, BootstrapDependencies{
		Registry: registry,
		Credentials: transport.CredentialResolver(func(context.Context, string) (string, error) {
			return "test-key", nil
		}),
	})
	if err == nil || !strings.Contains(err.Error(), "durable account configuration store") {
		t.Fatalf("expected durable account store error, got %v", err)
	}
}
