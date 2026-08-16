package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

func backupCols() []string {
	return []string{"id", "created_at", "size_bytes", "source_app", "source_version", "label", "storage_path", "content_hash"}
}

func backupRow(now time.Time) []any {
	return []any{"b1", now, int64(10), "app", 1, "lab", "/p", "hash"}
}

func TestBackupSQLMockSuccessAndErrors(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	meta := models.BackupMetadata{ID: "b1", CreatedAt: now, SizeBytes: 10, SourceApp: "app", SourceVersion: 1, Label: "lab", StoragePath: "/p", ContentHash: "hash"}

	t.Run("insert", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, backupCols(), backupRow(now))
		got, err := NewBunBackupRepository(db).Insert(ctx, meta)
		if err != nil || got.ID != "b1" {
			t.Fatalf("Insert = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).Insert(ctx, meta); err == nil {
			t.Fatal("expected insert error")
		}
	})

	t.Run("get", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, backupCols(), backupRow(now))
		got, err := NewBunBackupRepository(db).Get(ctx, "b1")
		if err != nil || got.ID != "b1" {
			t.Fatalf("Get = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).Get(ctx, "b1"); err == nil {
			t.Fatal("expected get error")
		}
	})

	t.Run("list", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, backupCols(), backupRow(now))
		got, err := NewBunBackupRepository(db).List(ctx)
		if err != nil || len(got) != 1 {
			t.Fatalf("List = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).List(ctx); err == nil {
			t.Fatal("expected list error")
		}
	})

	t.Run("listOlderThan", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryRows(mock, backupCols(), backupRow(now))
		got, err := NewBunBackupRepository(db).ListOlderThan(ctx, "2026-01-01")
		if err != nil || len(got) != 1 {
			t.Fatalf("ListOlderThan = %#v err=%v", got, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyQueryErr(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).ListOlderThan(ctx, "2026-01-01"); err == nil {
			t.Fatal("expected listOlderThan error")
		}
	})

	t.Run("delete", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		ok, err := NewBunBackupRepository(db).Delete(ctx, "b1")
		if err != nil || !ok {
			t.Fatalf("Delete = %v err=%v", ok, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).Delete(ctx, "b1"); err == nil {
			t.Fatal("expected delete error")
		}
	})

	t.Run("deleteOlderThan", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyExec(mock, nil)
		n, err := NewBunBackupRepository(db).DeleteOlderThan(ctx, "2026-01-01")
		if err != nil || n != 1 {
			t.Fatalf("DeleteOlderThan = %d err=%v", n, err)
		}
		db2, mock2 := newFakeBun(t)
		expectAnyExec(mock2, errors.New("db down"))
		if _, err := NewBunBackupRepository(db2).DeleteOlderThan(ctx, "2026-01-01"); err == nil {
			t.Fatal("expected deleteOlderThan error")
		}
	})
}

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
