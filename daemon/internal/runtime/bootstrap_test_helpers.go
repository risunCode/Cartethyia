package runtime

import (
	"context"
	"net/http"
	"testing"

	"github.com/cartethyia/daemon/internal/config"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/proxy/transport"
)

func fixtureHandler(t *testing.T, baseURL string) http.Handler {
	t.Helper()
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	handler, err := buildHandlerWith(config.Config{MaxBodyBytes: 1 << 20}.WithDefaults(), BootstrapDependencies{
		Registry: registry,
		Credentials: transport.CredentialResolver(func(_ context.Context, ref string) (string, error) {
			if ref != "provider:openai" {
				t.Fatalf("unexpected credential reference %q", ref)
			}
			return "test-key", nil
		}),
		BaseURLOverrides: map[string]string{"openai": baseURL},
	})
	if err != nil {
		t.Fatalf("build fixture handler: %v", err)
	}
	return handler
}
