package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	proxycontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestStoreCredentialResolverResolvesSecretsLateAndRedactsViews(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	if err := accounts.Put(ctx, &AccountConfig{
		ID:         "account-1",
		ProviderID: "provider-1",
		Kind:       KindAPIKey,
		Enabled:    true,
	}); err != nil {
		t.Fatalf("put account: %v", err)
	}
	secrets := NewMemorySecretStore()
	const material = "api-key-super-secret"
	if err := secrets.PutAccess(ctx, "account-1", NewSecretFromString(material)); err != nil {
		t.Fatalf("put access: %v", err)
	}
	records := NewMemoryRecordStore()
	if err := records.Put(ctx, &OAuthTokenRecord{
		AccountID:          "account-1",
		ProviderID:         "provider-1",
		Kind:               KindAPIKey,
		RefreshFingerprint: "fp:refresh",
	}); err != nil {
		t.Fatalf("put record: %v", err)
	}

	resolver, err := NewStoreCredentialResolver(StoreResolverOptions{
		Accounts: accounts,
		Secrets:  secrets,
		Records:  records,
	})
	if err != nil {
		t.Fatalf("new resolver: %v", err)
	}
	cfg, err := accounts.Get(ctx, "account-1")
	if err != nil {
		t.Fatalf("get account: %v", err)
	}
	resolved, err := resolver.Resolve(ctx, cfg.CredentialRef)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := string(resolved.Access.Reveal()); got != material {
		t.Fatalf("resolved access = %q, want %q", got, material)
	}
	if resolved.Metadata.Kind != KindAPIKey || resolved.Metadata.Origin != OriginAPIKey {
		t.Fatalf("unexpected metadata kind/origin: %#v", resolved.Metadata)
	}
	if !resolved.Metadata.HasAccess || !resolved.Metadata.HasRefresh {
		t.Fatalf("metadata presence bits = %#v", resolved.Metadata)
	}
	metadataJSON, err := json.Marshal(resolved.Metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	resolvedJSON, err := json.Marshal(resolved)
	if err != nil {
		t.Fatalf("marshal resolved credential: %v", err)
	}
	for name, payload := range map[string][]byte{"metadata": metadataJSON, "resolved": resolvedJSON} {
		if strings.Contains(string(payload), material) {
			t.Fatalf("%s leaked secret: %s", name, payload)
		}
	}
	if strings.Contains(fmt.Sprint(resolved), material) || strings.Contains(fmt.Sprintf("%#v", resolved), material) {
		t.Fatal("formatted resolved credential leaked secret")
	}
	resolved.Close()
	if resolved.Access != nil {
		t.Fatal("Close must release resolved access")
	}
}

func TestDeviceOriginSurvivesTokenProjection(t *testing.T) {
	token := &TokenSet{
		Access:    NewSecretFromString("device-access"),
		Refresh:   NewSecretFromString("device-refresh"),
		Origin:    OriginOAuthDevice,
		ExpiresAt: time.Now().Add(time.Hour),
	}
	clone := token.Clone()
	if clone.Origin != OriginOAuthDevice {
		t.Fatalf("clone origin = %q, want %q", clone.Origin, OriginOAuthDevice)
	}
	record := &OAuthTokenRecord{}
	record.FromTokenSet("account-1", "provider-1", KindDevice, token, time.Now())
	if record.Origin != OriginOAuthDevice {
		t.Fatalf("record origin = %q, want %q", record.Origin, OriginOAuthDevice)
	}
	token.Access.Close()
	token.Refresh.Close()
	clone.Access.Close()
	clone.Refresh.Close()
}

func TestSecretAndAuthErrorsRedactSerializedMaterial(t *testing.T) {
	const material = "refresh-token-secret"
	secret := NewSecretFromString(material)
	payload, err := json.Marshal(secret)
	if err != nil {
		t.Fatalf("marshal secret: %v", err)
	}
	var redacted string
	if err := json.Unmarshal(payload, &redacted); err != nil {
		t.Fatalf("decode redacted secret: %v", err)
	}
	if strings.Contains(string(payload), material) || redacted != "<redacted-secret>" {
		t.Fatalf("secret JSON = %s", payload)
	}
	secret.Close()

	authErr := NewError(ErrKindRefreshFatal, "provider-1", "account-1", errors.New("refresh_token="+material))
	if strings.Contains(authErr.Error(), material) || strings.Contains(fmt.Sprint(authErr.Unwrap()), material) {
		t.Fatalf("auth error leaked secret: %v", authErr)
	}
}

func TestCanonicalAndAdminAccountContractsCarryOnlyOpaqueReferences(t *testing.T) {
	ref, err := proxycontracts.NewCredentialRef("account-ref-1")
	if err != nil {
		t.Fatalf("new proxy credential ref: %v", err)
	}
	payload, err := json.Marshal(struct {
		Account   proxycontracts.Account
		Candidate proxycontracts.Candidate
		Exchange  proxycontracts.Exchange
	}{
		Account:  proxycontracts.Account{ID: "account-1", CredentialRef: ref},
		Exchange: proxycontracts.Exchange{Surface: proxycontracts.SurfaceOpenAIChat, RequestedModel: "model-1"},
		Candidate: proxycontracts.Candidate{
			ID:            "candidate-1",
			ProviderID:    "provider-1",
			ModelID:       "model-1",
			Surface:       proxycontracts.SurfaceOpenAIChat,
			CredentialRef: ref,
		},
	})
	if err != nil {
		t.Fatalf("marshal public contracts: %v", err)
	}
	if strings.Contains(string(payload), "refresh-token-secret") || strings.Contains(string(payload), "api-key-super-secret") {
		t.Fatalf("public contracts contain secret-shaped material: %s", payload)
	}
}

func TestAccountConfigStoreDoesNotRetainSecretFields(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryAccountConfigStore()
	if err := store.Put(ctx, &AccountConfig{ID: "account-1", ProviderID: "provider-1", Kind: KindAPIKey}); err != nil {
		t.Fatalf("put account: %v", err)
	}
	cfg, err := store.Get(ctx, "account-1")
	if err != nil {
		t.Fatalf("get account: %v", err)
	}
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal account config: %v", err)
	}
	if strings.Contains(string(payload), "secret") || strings.Contains(string(payload), "token") {
		t.Fatalf("account config contains secret-shaped fields: %s", payload)
	}
	if cfg.CredentialRef.IsZero() {
		t.Fatal("account config reference was not assigned")
	}
}
