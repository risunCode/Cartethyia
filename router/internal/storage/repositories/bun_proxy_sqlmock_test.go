package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
)

func proxyCols() []string {
	return []string{
		"id", "name", "protocol", "is_relay", "host", "port", "username", "password", "priority", "weight",
		"max_concurrency", "active", "created_at", "cooldown_until", "cooldown_level", "consecutive_use_count",
		"last_used_at", "updated_at", "last_test_at", "last_test_success_at", "last_test_success_latency_ms",
		"last_test_error_at", "last_test_error", "last_test_status_code",
	}
}

func proxyRowValues(now time.Time) []any {
	return []any{
		"proxy-1", "label", "http", false, "127.0.0.1", 8080, nil, nil, 100, 100,
		8, true, now, nil, 0, 0,
		nil, now, nil, nil, nil,
		nil, nil, nil,
	}
}

func TestProxySQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).List(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "proxy-1" {
			t.Fatalf("List = %#v err=%v", got, err)
		}
	})

	t.Run("get", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).Get(ctx, "proxy-1")
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("Get = %#v err=%v", got, err)
		}
	})

	t.Run("create", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).Create(ctx, models.ProxyCreateInput{
			ID: "proxy-1", Name: "label", Protocol: models.ProxyProtocolHTTP, Host: "127.0.0.1", Port: 8080,
		})
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("Create = %#v err=%v", got, err)
		}
	})

	t.Run("patch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		host := "10.0.0.1"
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).Patch(ctx, "proxy-1", models.ProxyPatchInput{Host: &host})
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("Patch = %#v err=%v", got, err)
		}
	})

	t.Run("recordTest", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		latency := 12
		got, err := NewBunProxyRepository(db).RecordTest(ctx, "proxy-1", models.ProxyTestResult{OK: true, LatencyMs: &latency})
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("RecordTest = %#v err=%v", got, err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunProxyRepository(db).Delete(ctx, "proxy-1")
		if err != nil || !ok {
			t.Fatalf("Delete = (%v, %v)", ok, err)
		}
	})

	t.Run("patch", func(t *testing.T) {
		db, mock := newFakeBun(t)
		name := "renamed"
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).Patch(ctx, "proxy-1", models.ProxyPatchInput{Name: &name})
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("Patch = %#v err=%v", got, err)
		}
	})

	t.Run("record test", func(t *testing.T) {
		db, mock := newFakeBun(t)
		latency := 12
		status := 200
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, proxyCols(), proxyRowValues(now))
		got, err := NewBunProxyRepository(db).RecordTest(ctx, "proxy-1", models.ProxyTestResult{OK: true, LatencyMs: &latency, StatusCode: &status})
		if err != nil || got.ID != "proxy-1" {
			t.Fatalf("RecordTest = %#v err=%v", got, err)
		}
	})
}

func TestProxySettingsAndHealthSQLMock(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	settingsCols := []string{"id", "enabled", "excluded_providers_json", "smart_dynamic_routing", "smart_dynamic_proxy_count", "routing_preset", "target_concurrent", "web_search_preference", "updated_at"}
	settingsRow := []any{1, true, []byte("[]"), true, 2, "auto", 0, "auto", now}
	healthCols := []string{"proxy_id", "status", "error_kind", "status_code", "sanitized_message", "occurred_at", "retry_at", "last_failure_at", "probe_until", "failure_count", "backoff_level", "updated_at"}
	healthRow := []any{"proxy-1", "healthy", nil, nil, nil, nil, nil, nil, nil, 0, 0, now}

	t.Run("settings", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, settingsCols, settingsRow)
		got, err := NewBunProxyRepository(db).GetSettings(ctx)
		if err != nil || !got.Enabled {
			t.Fatalf("GetSettings = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, settingsCols, settingsRow)
		patched, err := NewBunProxyRepository(db).PatchSettings(ctx, models.ProxySettings{Enabled: true, SmartDynamicRouting: true})
		if err != nil || !patched.SmartDynamicRouting {
			t.Fatalf("PatchSettings = %#v err=%v", patched, err)
		}
	})

	t.Run("health", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, healthCols, healthRow)
		got, err := NewBunProxyRepository(db).GetHealth(ctx, "proxy-1")
		if err != nil || got.ProxyID != "proxy-1" {
			t.Fatalf("GetHealth = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		if err := NewBunProxyRepository(db).UpsertHealth(ctx, models.ProxyHealth{ProxyID: "proxy-1", Status: "healthy"}); err != nil {
			t.Fatalf("UpsertHealth: %v", err)
		}
		expectAnyQueryRows(mock, healthCols, healthRow)
		if _, err := NewBunProxyRepository(db).RecordHealthFailure(ctx, "proxy-1", "connect", "msg", now, time.Minute, 3, time.Minute, time.Hour); err != nil {
			t.Fatalf("RecordHealthFailure: %v", err)
		}
		expectAnyExec(mock, nil)
		if err := NewBunProxyRepository(db).RecordHealthSuccess(ctx, "proxy-1", now); err != nil {
			t.Fatalf("RecordHealthSuccess: %v", err)
		}
		expectAnyExec(mock, nil)
		claimed, err := NewBunProxyRepository(db).ClaimHealthProbe(ctx, "proxy-1", now, now.Add(time.Minute))
		if err != nil || !claimed {
			t.Fatalf("ClaimHealthProbe = (%v, %v)", claimed, err)
		}
	})

	t.Run("db error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, errors.New("db down"))
		if _, err := NewBunProxyRepository(db).List(ctx); err == nil {
			t.Fatal("expected list error")
		}
	})
}
