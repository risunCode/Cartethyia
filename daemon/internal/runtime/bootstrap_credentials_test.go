package runtime

import (
	"context"
	"os"
	"testing"

	"github.com/cartethyia/daemon/internal/accounts"
)

func TestBootstrapCredentialCompositionKeepsDevelopmentFallback(t *testing.T) {
	deps, err := defaultBootstrapDependencies(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("default bootstrap dependencies: %v", err)
	}
	if deps.Credentials == nil {
		t.Fatal("development bootstrap lost its fail-closed credential fallback")
	}
	if deps.Database != nil || deps.Accounts != nil || deps.Secrets != nil {
		t.Fatal("test bootstrap unexpectedly opened durable stores")
	}
}

func TestComposeCredentialResolverUsesDurableStoresWithoutOverride(t *testing.T) {
	ctx := context.Background()
	accountStore := accounts.NewMemoryAccountConfigStore()
	if err := accountStore.Put(ctx, &accounts.AccountConfig{
		ID:         "account-1",
		ProviderID: "openai",
		Kind:       accounts.KindAPIKey,
		Enabled:    true,
	}); err != nil {
		t.Fatalf("put account: %v", err)
	}
	secrets := accounts.NewMemorySecretStore()
	const material = "test-api-key"
	if err := secrets.PutAccess(ctx, "account-1", accounts.NewSecretFromString(material)); err != nil {
		t.Fatalf("put access: %v", err)
	}

	resolver, err := composeCredentialResolver(BootstrapDependencies{
		Accounts: accountStore,
		Secrets:  secrets,
	})
	if err != nil {
		t.Fatalf("compose resolver: %v", err)
	}
	got, err := resolver(ctx, "account-1")
	if err != nil {
		t.Fatalf("resolve credential: %v", err)
	}
	if got != material {
		t.Fatalf("credential = %q, want %q", got, material)
	}
}

func TestDefaultBootstrapClearsFallbackWithPostgreSQL(t *testing.T) {
	rawURL := os.Getenv("CARTETHYIA_POSTGRES_URL")
	if rawURL == "" {
		t.Skip("set CARTETHYIA_POSTGRES_URL to run PostgreSQL bootstrap coverage")
	}
	deps, err := defaultBootstrapDependencies(Config{
		DatabaseURL:          rawURL,
		AccountEncryptionKey: "integration-key-material-32-bytes-long",
	}.WithDefaults())
	if err != nil {
		t.Fatalf("PostgreSQL bootstrap dependencies: %v", err)
	}
	defer deps.Database.Close(context.Background())
	if deps.Credentials != nil {
		t.Fatal("PostgreSQL bootstrap retained the rejecting credential resolver")
	}
	if deps.Accounts == nil || deps.Secrets == nil {
		t.Fatal("PostgreSQL bootstrap did not compose durable account and secret stores")
	}
}
