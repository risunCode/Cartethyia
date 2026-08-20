package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
)
func TestBanSQLMockSuccessAndErrors(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	banCols := []string{"ip", "reason", "created_at"}
	offenseCols := []string{"ip", "category", "strike_count", "window_started_at", "last_event_at"}

	t.Run("isBanned", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, []string{"exists"}, []any{true})
		ok, err := NewBunBanRepository(db).IsBanned(ctx, "1.2.3.4")
		if err != nil || !ok {
			t.Fatalf("IsBanned = %v err=%v", ok, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).IsBanned(ctx, "1.2.3.4"); err == nil {
			t.Fatal("expected IsBanned error")
		}
	})

	t.Run("getBan", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, banCols, []any{"1.2.3.4", "abuse", now})
		got, err := NewBunBanRepository(db).GetBan(ctx, "1.2.3.4")
		if err != nil || got.IP != "1.2.3.4" {
			t.Fatalf("GetBan = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).GetBan(ctx, "1.2.3.4"); err == nil {
			t.Fatal("expected GetBan error")
		}
	})

	t.Run("listBans", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, banCols, []any{"1.2.3.4", "abuse", now})
		got, err := NewBunBanRepository(db).ListBans(ctx)
		if err != nil || len(got) != 1 {
			t.Fatalf("ListBans = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).ListBans(ctx); err == nil {
			t.Fatal("expected ListBans error")
		}
	})

	t.Run("upsertBan", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, banCols, []any{"1.2.3.4", "abuse", now})
		got, err := NewBunBanRepository(db).UpsertBan(ctx, models.IPBan{IP: "1.2.3.4", Reason: "abuse", CreatedAt: now})
		if err != nil || got.IP != "1.2.3.4" {
			t.Fatalf("UpsertBan = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).UpsertBan(ctx, models.IPBan{IP: "1.2.3.4", Reason: "abuse", CreatedAt: now}); err == nil {
			t.Fatal("expected UpsertBan error")
		}
	})

	t.Run("deleteBan", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunBanRepository(db).DeleteBan(ctx, "1.2.3.4")
		if err != nil || !ok {
			t.Fatalf("DeleteBan = %v err=%v", ok, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).DeleteBan(ctx, "1.2.3.4"); err == nil {
			t.Fatal("expected DeleteBan error")
		}
	})

	t.Run("incrementOffense", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		expectAnyQueryRows(mock, offenseCols, []any{"1.2.3.4", "auth", 2, now, now})
		got, err := NewBunBanRepository(db).IncrementOffense(ctx, "1.2.3.4", "auth", now.Format(time.RFC3339))
		if err != nil || got.StrikeCount != 2 {
			t.Fatalf("IncrementOffense = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).IncrementOffense(ctx, "1.2.3.4", "auth", now.Format(time.RFC3339)); err == nil {
			t.Fatal("expected IncrementOffense error")
		}
	})

	t.Run("resetOffense", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		if err := NewBunBanRepository(db).ResetOffense(ctx, "1.2.3.4", "auth"); err != nil {
			t.Fatal(err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if err := NewBunBanRepository(db2).ResetOffense(ctx, "1.2.3.4", "auth"); err == nil {
			t.Fatal("expected ResetOffense error")
		}
	})

	t.Run("listOffenses", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, offenseCols, []any{"1.2.3.4", "auth", 2, now, now})
		got, err := NewBunBanRepository(db).ListOffenses(ctx, "1.2.3.4")
		if err != nil || len(got) != 1 || got[0].Category != "auth" {
			t.Fatalf("ListOffenses = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBanRepository(db2).ListOffenses(ctx, ""); err == nil {
			t.Fatal("expected ListOffenses error")
		}
	})
}
