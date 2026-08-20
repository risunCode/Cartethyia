package services

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"

	"github.com/cartethyia/daemon/internal/storage/models"
	"golang.org/x/crypto/bcrypt"
)

// fakeAdminKeyStore is an in-memory adminAPIKeyLister used by the seeding
// tests. It records the credentials passed to Create so the tests can
// confirm the seeder persists exactly the expected payload.
type fakeAdminKeyStore struct {
	mu       sync.Mutex
	existing []models.ApiKey
	created  []models.ApiKeyCreateInput
	listErr  error
	createErr error
}

func (f *fakeAdminKeyStore) List(_ context.Context) ([]models.ApiKey, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]models.ApiKey, len(f.existing))
	copy(out, f.existing)
	return out, nil
}

func (f *fakeAdminKeyStore) Create(_ context.Context, in models.ApiKeyCreateInput) (models.ApiKey, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return models.ApiKey{}, f.createErr
	}
	f.created = append(f.created, in)
	row := models.ApiKey{ID: in.ID, Name: in.Name, Active: true, KeyPrefix: in.KeyPrefix}
	f.existing = append(f.existing, row)
	return row, nil
}

func newTestLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})), &buf
}

func TestSeedAdminCredentials_CreatesKeyWhenMissing(t *testing.T) {
	t.Parallel()
	store := &fakeAdminKeyStore{}
	logger, buf := newTestLogger()

	if err := seedAdminCredentialsWith(context.Background(), store, "s3cret-pass", logger); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got := len(store.created); got != 1 {
		t.Fatalf("Create call count = %d, want 1", got)
	}
	created := store.created[0]
	if created.Name != "admin" || created.ID != "admin" {
		t.Fatalf("created key name/id = %q/%q, want admin/admin", created.Name, created.ID)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(created.Key), []byte("s3cret-pass")); err != nil {
		t.Fatalf("stored hash does not verify against the seeded password: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("admin credentials seeded from CONSOLE_PASSWORD")) {
		t.Fatalf("expected seeded info log, got: %s", buf.String())
	}
}

func TestSeedAdminCredentials_EmptyPasswordWarns(t *testing.T) {
	t.Parallel()
	store := &fakeAdminKeyStore{}
	logger, buf := newTestLogger()

	if err := seedAdminCredentialsWith(context.Background(), store, "", logger); err != nil {
		t.Fatalf("seed with empty password: %v", err)
	}
	if len(store.created) != 0 {
		t.Fatalf("expected no rows created, got %d", len(store.created))
	}
	if !bytes.Contains(buf.Bytes(), []byte("CONSOLE_PASSWORD not set")) {
		t.Fatalf("expected missing-password warning, got: %s", buf.String())
	}
}

func TestSeedAdminCredentials_SkipsWhenExisting(t *testing.T) {
	t.Parallel()
	store := &fakeAdminKeyStore{existing: []models.ApiKey{{ID: "admin", Name: "admin"}}}
	logger, buf := newTestLogger()

	if err := seedAdminCredentialsWith(context.Background(), store, "would-be-overwritten", logger); err != nil {
		t.Fatalf("seed with existing admin: %v", err)
	}
	if len(store.created) != 0 {
		t.Fatalf("expected zero Create calls when admin already exists, got %d", len(store.created))
	}
	if !bytes.Contains(buf.Bytes(), []byte("admin credentials already seeded")) {
		t.Fatalf("expected skip info log, got: %s", buf.String())
	}
}

func TestSeedAdminCredentials_NilStoreErrors(t *testing.T) {
	t.Parallel()
	logger, _ := newTestLogger()
	if err := seedAdminCredentialsWith(context.Background(), nil, "x", logger); err == nil {
		t.Fatal("expected error when store is nil")
	}
}

func TestSeedAdminCredentials_ListErrorPropagates(t *testing.T) {
	t.Parallel()
	boom := errors.New("db unavailable")
	store := &fakeAdminKeyStore{listErr: boom}
	logger, _ := newTestLogger()
	if err := seedAdminCredentialsWith(context.Background(), store, "x", logger); err == nil || !errors.Is(err, boom) {
		t.Fatalf("expected wrapped list error, got %v", err)
	}
}

func TestSeedAdminCredentials_NilLoggerDefaults(t *testing.T) {
	t.Parallel()
	store := &fakeAdminKeyStore{}
	if err := seedAdminCredentialsWith(context.Background(), store, "s3cret-pass", nil); err != nil {
		t.Fatalf("seed with nil logger: %v", err)
	}
	if len(store.created) != 1 {
		t.Fatalf("expected one created key, got %d", len(store.created))
	}
}
