package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/migrations"
)

func TestOpenBunRejectsIncompleteConfig(t *testing.T) {
	_, err := OpenBun(context.Background(), Config{})
	if err == nil {
		t.Fatal("OpenBun accepted an incomplete configuration")
	}
}

func TestOpenRuntimeFailsWhenPostgreSQLUnavailable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if _, err := OpenRuntime(ctx, "postgres://cartethyia@127.0.0.1:1/cartethyia?sslmode=disable"); err == nil {
		t.Fatal("OpenRuntime accepted an unavailable PostgreSQL server")
	}
}

func TestNilBunDatabaseIsSafeToClose(t *testing.T) {
	var database *BunDatabase
	if err := database.Close(); err != nil {
		t.Fatalf("Close(nil) = %v", err)
	}
	if database.Bun() != nil {
		t.Fatal("Bun(nil) returned a database handle")
	}
}

func TestClosedBunDatabaseReturnsTypedError(t *testing.T) {
	database := &BunDatabase{}
	if err := database.Exec(context.Background(), "SELECT 1"); err == nil {
		t.Fatal("Exec on closed database returned nil")
	}
	if _, err := database.Query(context.Background(), "SELECT 1"); err == nil {
		t.Fatal("Query on closed database returned nil")
	}
	if err := database.InTransaction(context.Background(), func(migrations.Driver) error { return nil }); err == nil {
		t.Fatal("InTransaction on closed database returned nil")
	} else if errors.Is(err, context.Canceled) {
		t.Fatalf("closed database error unexpectedly reports cancellation: %v", err)
	}
}
