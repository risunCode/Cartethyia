package repositories

import (
	"context"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

func TestOverviewStatsAggregatesAndRoutes(t *testing.T) {
	ctx := context.Background()
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock,
		[]string{"requests", "errors", "p50_ms", "p95_ms", "p99_ms"},
		[]any{int64(12), int64(3), int64(100), int64(900), int64(1500)},
	)
	expectAnyQueryRows(mock, []string{"route", "count"}, []any{"daemon.proxy", int64(12)})
	from := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	got, err := NewBunTelemetryRepository(db).OverviewStats(ctx, from, to, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Requests != 12 || got.Errors != 3 || got.P50MS != 100 || got.P95MS != 900 || got.P99MS != 1500 {
		t.Fatalf("overview = %#v", got)
	}
	if got.ByRoute["daemon.proxy"] != 12 {
		t.Fatalf("byRoute = %#v", got.ByRoute)
	}
}

func TestOverviewStatsSurfaceFilter(t *testing.T) {
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock,
		[]string{"requests", "errors", "p50_ms", "p95_ms", "p99_ms"},
		[]any{int64(0), int64(0), int64(0), int64(0), int64(0)},
	)
	expectAnyQueryRows(mock, []string{"route", "count"})
	got, err := NewBunTelemetryRepository(db).OverviewStats(context.Background(), time.Now(), time.Now(), "client_action")
	if err != nil {
		t.Fatal(err)
	}
	if got.Requests != 0 || got.ByRoute != nil {
		t.Fatalf("overview = %#v", got)
	}
}

func TestTimeBucketsRowsAndGranularityGuard(t *testing.T) {
	ctx := context.Background()
	db, mock := newFakeBun(t)
	ts := time.Date(2026, 8, 16, 11, 0, 0, 0, time.UTC)
	expectAnyQueryRows(mock,
		[]string{"ts", "count", "errors", "latency_ms"},
		[]any{ts, int64(5), int64(1), int64(250)},
	)
	got, err := NewBunTelemetryRepository(db).TimeBuckets(ctx, time.Now().Add(-time.Hour), time.Now(), "hour", "", false, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !got[0].Timestamp.Equal(ts) || got[0].Count != 5 || got[0].Errors != 1 || got[0].LatencyMS != 250 {
		t.Fatalf("buckets = %#v", got)
	}
	if _, err := NewBunTelemetryRepository(db).TimeBuckets(ctx, time.Now(), time.Now(), "week", "", false, 10); err == nil {
		t.Fatal("unsupported granularity accepted")
	}
}

func TestUpstreamGroupsProviderAndModelShapes(t *testing.T) {
	ctx := context.Background()
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock, []string{"provider", "count", "errors", "latency_ms"}, []any{"openai", int64(7), int64(2), int64(400)})
	got, err := NewBunTelemetryRepository(db).UpstreamGroups(ctx, time.Now().Add(-time.Hour), time.Now(), "", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Provider != "openai" || got[0].Model != "" || got[0].Count != 7 {
		t.Fatalf("groups = %#v", got)
	}

	db, mock = newFakeBun(t)
	expectAnyQueryRows(mock, []string{"provider", "model", "count", "errors", "latency_ms"}, []any{"anthropic", "claude-3", int64(4), int64(0), int64(300)})
	got, err = NewBunTelemetryRepository(db).UpstreamGroups(ctx, time.Now().Add(-time.Hour), time.Now(), "model", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Model != "claude-3" {
		t.Fatalf("groups = %#v", got)
	}
}

func TestUsageTotalsSumsAndMaps(t *testing.T) {
	ctx := context.Background()
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock,
		[]string{"requests", "input_tokens", "output_tokens", "total_tokens"},
		[]any{int64(9), int64(100), int64(50), int64(150)},
	)
	expectAnyQueryRows(mock, []string{"label", "tokens"}, []any{"openai", int64(150)})
	expectAnyQueryRows(mock, []string{"label", "tokens"}, []any{"gpt-x", int64(150)})
	got, err := NewBunTelemetryRepository(db).UsageTotals(ctx, time.Now().Add(-24*time.Hour), time.Now(), "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Requests != 9 || got.InputTokens != 100 || got.OutputTokens != 50 || got.TotalTokens != 150 {
		t.Fatalf("totals = %#v", got)
	}
	if got.ByProvider["openai"] != 150 || got.ByModel["gpt-x"] != 150 {
		t.Fatalf("maps = %#v", got)
	}
}

func TestClientUsageUnknownFamily(t *testing.T) {
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock, []string{"client", "source", "count"},
		[]any{"claude-cli", "user_agent", int64(3)},
		[]any{"unknown", "proxy", int64(1)},
	)
	got, err := NewBunTelemetryRepository(db).ClientUsage(context.Background(), time.Now().Add(-24*time.Hour), time.Now(), "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Client != "claude-cli" || got[1].Client != "unknown" || got[1].Source != "proxy" {
		t.Fatalf("clients = %#v", got)
	}
}

func TestListConsoleLogsFiltered(t *testing.T) {
	ctx := context.Background()
	ts := time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC)
	db, mock := newFakeBun(t)
	expectAnyQueryRows(mock, []string{"id", "ts", "level", "scope", "msg"}, []any{int64(7), ts, "warn", "http", "request quota_exceeded"})
	got, err := NewBunTelemetryRepository(db).ListConsoleLogsFiltered(ctx, models.ConsoleLogFilter{From: ts.Add(-time.Hour), To: ts, Level: "warn", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != 7 || got[0].Level != "warn" || got[0].Scope != "http" || got[0].Message != "request quota_exceeded" {
		t.Fatalf("logs = %#v", got)
	}
}

func TestAdminTelemetryReadsFailClosedWithoutDatabase(t *testing.T) {
	ctx := context.Background()
	var repo *BunTelemetryRepository
	if _, err := repo.OverviewStats(ctx, time.Now(), time.Now(), ""); err != ErrRepositoryClosed {
		t.Fatalf("OverviewStats closed = %v", err)
	}
	if _, err := repo.TimeBuckets(ctx, time.Now(), time.Now(), "hour", "", false, 1); err != ErrRepositoryClosed {
		t.Fatalf("TimeBuckets closed = %v", err)
	}
	if _, err := repo.UpstreamGroups(ctx, time.Now(), time.Now(), "", "", 1); err != ErrRepositoryClosed {
		t.Fatalf("UpstreamGroups closed = %v", err)
	}
	if _, err := repo.UsageTotals(ctx, time.Now(), time.Now(), ""); err != ErrRepositoryClosed {
		t.Fatalf("UsageTotals closed = %v", err)
	}
	if _, err := repo.ClientUsage(ctx, time.Now(), time.Now(), "", 1); err != ErrRepositoryClosed {
		t.Fatalf("ClientUsage closed = %v", err)
	}
	if _, err := repo.ListConsoleLogsFiltered(ctx, models.ConsoleLogFilter{}); err != ErrRepositoryClosed {
		t.Fatalf("ListConsoleLogsFiltered closed = %v", err)
	}
}
