package app

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	consoleservices "github.com/cartethyia/daemon/internal/console/services"
	"github.com/cartethyia/daemon/internal/storage/repositories"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

func newRuntimeFakeBun(t *testing.T) (*bun.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	db := bun.NewDB(sqlDB, pgdialect.New())
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

func TestPublicAPIKeyResolverResolveAndTouch(t *testing.T) {
	db, mock := newRuntimeFakeBun(t)
	mock.ExpectQuery(".*").WillReturnRows(sqlmock.NewRows([]string{
		"id", "active", "revoked_at", "rate_limit_rpm", "daily_token_limit", "monthly_token_limit",
		"one_time_token_limit", "one_time_tokens_used", "max_concurrent_requests", "provider_allowlist", "model_allowlist", "model_denylist",
	}).AddRow("key-1", true, nil, nil, nil, nil, nil, 0, nil, nil, nil, nil))
	resolver := publicAPIKeyResolver{store: repositories.NewBunPublicAPIKeyResolver(db)}
	got, err := resolver.ResolveAPIKey(context.Background(), "sk-test")
	if err != nil || got.ID != "key-1" || !got.Active {
		t.Fatalf("ResolveAPIKey = (%+v, %v)", got, err)
	}
	mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 1))
	if err := resolver.TouchAPIKey(context.Background(), "key-1"); err != nil {
		t.Fatalf("TouchAPIKey: %v", err)
	}
}

func TestPublicAPIKeyResolverNotFound(t *testing.T) {
	db, mock := newRuntimeFakeBun(t)
	mock.ExpectQuery(".*").WillReturnError(sql.ErrNoRows)
	resolver := publicAPIKeyResolver{store: repositories.NewBunPublicAPIKeyResolver(db)}
	if _, err := resolver.ResolveAPIKey(context.Background(), "missing"); err == nil {
		t.Fatal("expected not found error")
	}
}

func TestDefaultBootstrapDependenciesDevMode(t *testing.T) {
	deps, err := defaultBootstrapDependencies(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("defaultBootstrapDependencies: %v", err)
	}
	if deps.Registry == nil || deps.Cache == nil || deps.Credentials == nil {
		t.Fatalf("missing dev dependencies: %#v", deps)
	}
}

func TestDefaultBootstrapDependenciesRejectsProductionWithoutDatabase(t *testing.T) {
	_, err := defaultBootstrapDependencies(Config{Environment: "production"}.WithDefaults())
	if err == nil {
		t.Fatal("expected production database requirement")
	}
}

func TestRandomAdminHelpers(t *testing.T) {
	id, err := consoleservices.RandomAdminID("adm")
	if err != nil || id == "" {
		t.Fatalf("randomAdminID = (%q, %v)", id, err)
	}
	secret, err := consoleservices.RandomAdminSecret(16)
	if err != nil || secret == "" {
		t.Fatalf("randomAdminSecret = (%q, %v)", secret, err)
	}
}
