package repositories

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	contracts "github.com/cartethyia/daemon/internal/console/contracts"
	"github.com/DATA-DOG/go-sqlmock"
)

func proxyAdminCols() []string {
	return []string{
		"id", "protocol", "host", "port", "priority", "weight",
		"max_concurrency", "active", "created_at", "updated_at",
	}
}

func proxyAdminRowValues(now time.Time) []any {
	return []any{
		"proxy-1", "http", "127.0.0.1", 8080, 100, 100,
		8, true, now, now,
	}
}

func TestProxyAdminSQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	cols := proxyAdminCols()
	values := proxyAdminRowValues(now)
	healthCols := []string{"proxy_id", "status"}

	t.Run("list empty", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, cols)
		got, err := NewBunProxyAdminRepository(db).List(ctx)
		if err != nil {
			t.Fatalf("List err: %v", err)
		}
		if got == nil {
			t.Fatal("List returned nil slice, want empty slice")
		}
		if len(got) != 0 {
			t.Fatalf("List len = %d, want 0", len(got))
		}
	})

	t.Run("list with health", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, cols, values)
		expectAnyQueryRows(mock, healthCols, []any{"proxy-1", "healthy"})
		got, err := NewBunProxyAdminRepository(db).List(ctx)
		if err != nil {
			t.Fatalf("List err: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("List len = %d, want 1", len(got))
		}
		if got[0].ID != "proxy-1" || got[0].Health != "healthy" || got[0].Type != "http" {
			t.Fatalf("List[0] = %#v", got[0])
		}
	})

	t.Run("list with missing health defaults to unknown", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, cols, values)
		expectAnyQueryRows(mock, healthCols)
		got, err := NewBunProxyAdminRepository(db).List(ctx)
		if err != nil {
			t.Fatalf("List err: %v", err)
		}
		if len(got) != 1 || got[0].Health != "unknown" {
			t.Fatalf("List[0].Health = %q, want unknown", got[0].Health)
		}
	})

	t.Run("list error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, errors.New("db down"))
		if _, err := NewBunProxyAdminRepository(db).List(ctx); err == nil {
			t.Fatal("expected List error")
		}
	})

	t.Run("create success", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, cols, values)
		expectAnyQueryRows(mock, healthCols, []any{"proxy-1", "healthy"})
		kind := "http"
		host := "127.0.0.1"
		port := 8080
		got, err := NewBunProxyAdminRepository(db).Create(ctx, contracts.ProxyInput{
			Type: &kind, Host: &host, Port: &port,
		})
		if err != nil {
			t.Fatalf("Create err: %v", err)
		}
		if got.ID != "proxy-1" || got.Type != "http" || got.Host != "127.0.0.1" {
			t.Fatalf("Create = %#v", got)
		}
	})

	t.Run("create validation rejects missing fields", func(t *testing.T) {
		db, _ := newFakeBun(t)
		host := "127.0.0.1"
		port := 8080
		if _, err := NewBunProxyAdminRepository(db).Create(ctx, contracts.ProxyInput{Host: &host, Port: &port}); err == nil {
			t.Fatal("expected validation error")
		}
	})

	t.Run("create validation rejects unsupported type", func(t *testing.T) {
		db, _ := newFakeBun(t)
		bad := "ftp"
		host := "127.0.0.1"
		port := 8080
		if _, err := NewBunProxyAdminRepository(db).Create(ctx, contracts.ProxyInput{Type: &bad, Host: &host, Port: &port}); err == nil {
			t.Fatal("expected validation error")
		}
	})

	t.Run("create validation rejects invalid port", func(t *testing.T) {
		db, _ := newFakeBun(t)
		kind := "http"
		host := "127.0.0.1"
		port := 0
		if _, err := NewBunProxyAdminRepository(db).Create(ctx, contracts.ProxyInput{Type: &kind, Host: &host, Port: &port}); err == nil {
			t.Fatal("expected validation error")
		}
	})

	t.Run("create error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, errors.New("insert failed"))
		kind := "http"
		host := "127.0.0.1"
		port := 8080
		if _, err := NewBunProxyAdminRepository(db).Create(ctx, contracts.ProxyInput{Type: &kind, Host: &host, Port: &port}); err == nil {
			t.Fatal("expected Create error")
		}
	})

	t.Run("update success", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, cols, values)
		expectAnyQueryRows(mock, healthCols, []any{"proxy-1", "healthy"})
		host := "10.0.0.1"
		got, err := NewBunProxyAdminRepository(db).Update(ctx, "proxy-1", contracts.ProxyInput{Host: &host})
		if err != nil {
			t.Fatalf("Update err: %v", err)
		}
		if got.ID != "proxy-1" {
			t.Fatalf("Update = %#v", got)
		}
	})

	t.Run("update validation rejects unsupported type", func(t *testing.T) {
		db, _ := newFakeBun(t)
		bad := "ftp"
		if _, err := NewBunProxyAdminRepository(db).Update(ctx, "proxy-1", contracts.ProxyInput{Type: &bad}); err == nil {
			t.Fatal("expected validation error")
		}
	})

	t.Run("update validation rejects empty payload", func(t *testing.T) {
		db, _ := newFakeBun(t)
		if _, err := NewBunProxyAdminRepository(db).Update(ctx, "proxy-1", contracts.ProxyInput{}); err == nil {
			t.Fatal("expected empty payload error")
		}
	})

	t.Run("update empty id rejected", func(t *testing.T) {
		db, _ := newFakeBun(t)
		host := "10.0.0.1"
		if _, err := NewBunProxyAdminRepository(db).Update(ctx, "  ", contracts.ProxyInput{Host: &host}); err == nil {
			t.Fatal("expected empty id error")
		}
	})

	t.Run("update not found", func(t *testing.T) {
		db, mock := newFakeBun(t)
		mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))
		host := "10.0.0.1"
		_, err := NewBunProxyAdminRepository(db).Update(ctx, "missing", contracts.ProxyInput{Host: &host})
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("Update err = %v, want sql.ErrNoRows", err)
		}
	})

	t.Run("update error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, errors.New("update failed"))
		host := "10.0.0.1"
		if _, err := NewBunProxyAdminRepository(db).Update(ctx, "proxy-1", contracts.ProxyInput{Host: &host}); err == nil {
			t.Fatal("expected Update error")
		}
	})

	t.Run("delete success", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunProxyAdminRepository(db).Delete(ctx, "proxy-1"); err != nil {
			t.Fatalf("Delete err: %v", err)
		}
	})

	t.Run("delete not found", func(t *testing.T) {
		db, mock := newFakeBun(t)
		mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))
		err := NewBunProxyAdminRepository(db).Delete(ctx, "missing")
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("Delete err = %v, want sql.ErrNoRows", err)
		}
	})

	t.Run("delete error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, errors.New("delete failed"))
		if err := NewBunProxyAdminRepository(db).Delete(ctx, "proxy-1"); err == nil {
			t.Fatal("expected Delete error")
		}
	})

	t.Run("delete empty id rejected", func(t *testing.T) {
		db, _ := newFakeBun(t)
		if err := NewBunProxyAdminRepository(db).Delete(ctx, "  "); err == nil {
			t.Fatal("expected empty id error")
		}
	})

	t.Run("closed repository", func(t *testing.T) {
		r := NewBunProxyAdminRepository(nil)
		mustClosed(t, r.ready())
		if _, err := r.List(ctx); err == nil {
			t.Fatal("expected closed List error")
		}
		kind := "http"
		host := "127.0.0.1"
		port := 8080
		if _, err := r.Create(ctx, contracts.ProxyInput{Type: &kind, Host: &host, Port: &port}); err == nil {
			t.Fatal("expected closed Create error")
		}
		if _, err := r.Update(ctx, "x", contracts.ProxyInput{Host: &host}); err == nil {
			t.Fatal("expected closed Update error")
		}
		if err := r.Delete(ctx, "x"); err == nil {
			t.Fatal("expected closed Delete error")
		}
	})
}
