package db

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cartethyia/daemon/internal/storage/migrations"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

func TestParseConfigAndDSNVariants(t *testing.T) {
	tests := []struct {
		name    string
		rawURL  string
		want    Config
		wantErr bool
	}{
		{
			name:   "postgresql with pool overrides",
			rawURL: "postgresql://alice:secret@example.test:5544/cartethyia?sslmode=require&max_open_conns=8&max_idle_conns=2",
			want:   Config{Host: "example.test", Port: 5544, User: "alice", Password: "secret", Database: "cartethyia", SSLMode: "require", MaxOpenConns: 8, MaxIdleConns: 2},
		},
		{
			name:   "postgres defaults",
			rawURL: "postgres://alice@example.test/cartethyia",
			want:   Config{Host: "example.test", Port: 5432, User: "alice", Database: "cartethyia", SSLMode: "prefer", MaxOpenConns: 16, MaxIdleConns: 4},
		},
		{name: "empty", rawURL: "  ", wantErr: true},
		{name: "unsupported scheme", rawURL: "mysql://alice@example.test/db", wantErr: true},
		{name: "invalid port", rawURL: "postgres://alice@example.test:not-a-port/db", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseConfig(tt.rawURL)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseConfig() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if got != tt.want {
				t.Fatalf("ParseConfig() = %#v, want %#v", got, tt.want)
			}
			parsed, err := url.Parse(got.DSN())
			if err != nil {
				t.Fatalf("DSN parse: %v", err)
			}
			if parsed.Scheme != "postgres" || parsed.Host != got.Host+":"+strconv.Itoa(got.Port) || parsed.Path != "/"+got.Database {
				t.Fatalf("DSN = %q", got.DSN())
			}
			if parsed.Query().Get("sslmode") != got.SSLMode {
				t.Fatalf("DSN sslmode = %q", parsed.Query().Get("sslmode"))
			}
		})
	}
}

func newMockBun(t *testing.T) (*BunDatabase, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	bunDB := bun.NewDB(sqlDB, pgdialect.New())
	t.Cleanup(func() {
		_ = bunDB.Close()
	})
	return &BunDatabase{sqlDB: sqlDB, bunDB: bunDB}, mock
}

func TestBunDatabaseDelegatesQueriesAndPing(t *testing.T) {
	sqlDB, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatal(err)
	}
	bunDB := bun.NewDB(sqlDB, pgdialect.New())
	database := &BunDatabase{sqlDB: sqlDB, bunDB: bunDB}
	t.Cleanup(func() { _ = bunDB.Close() })
	mock.ExpectPing()
	if err := database.Ping(context.Background()); err != nil {
		t.Fatalf("Ping() = %v", err)
	}
	mock.ExpectExec(regexp.QuoteMeta("UPDATE settings SET value = 'enabled'")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	if err := database.Exec(context.Background(), "UPDATE settings SET value = 'enabled'"); err != nil {
		t.Fatalf("Exec() = %v", err)
	}
	rows := sqlmock.NewRows([]string{"value"}).AddRow("enabled")
	mock.ExpectQuery(regexp.QuoteMeta("SELECT value FROM settings")).
		WillReturnRows(rows)
	result, err := database.Query(context.Background(), "SELECT value FROM settings")
	if err != nil {
		t.Fatalf("Query() = %v", err)
	}
	if !result.Next() {
		t.Fatal("Query() returned no rows")
	}
	var value string
	if err := result.Scan(&value); err != nil || value != "enabled" {
		t.Fatalf("Scan() = %q, %v", value, err)
	}
	if result.Err() != nil {
		t.Fatalf("Err() = %v", result.Err())
	}
	if err := result.Close(); err != nil {
		t.Fatalf("Close() = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestBunDatabaseTransactionsCommitAndRollback(t *testing.T) {
	t.Run("commit", func(t *testing.T) {
		database, mock := newMockBun(t)
		mock.ExpectBegin()
		mock.ExpectExec(regexp.QuoteMeta("INSERT INTO settings (value) VALUES ('ok')")).
			WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery(regexp.QuoteMeta("SELECT value")).
			WillReturnRows(sqlmock.NewRows([]string{"value"}).AddRow("ok"))
		mock.ExpectCommit()
		err := database.InTransaction(context.Background(), func(driver migrations.Driver) error {
			if err := driver.Exec(context.Background(), "INSERT INTO settings (value) VALUES ('ok')"); err != nil {
				return err
			}
			rows, err := driver.Query(context.Background(), "SELECT value")
			if err != nil {
				return err
			}
			defer rows.Close()
			if !rows.Next() {
				return errors.New("transaction query returned no rows")
			}
			var value string
			if err := rows.Scan(&value); err != nil {
				return err
			}
			if value != "ok" {
				return errors.New("unexpected transaction value")
			}
			return nil
		})
		if err != nil {
			t.Fatalf("InTransaction() = %v", err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("rollback and nested transaction", func(t *testing.T) {
		database, mock := newMockBun(t)
		mock.ExpectBegin()
		wantErr := errors.New("callback failed")
		mock.ExpectRollback()
		err := database.InTransaction(context.Background(), func(driver migrations.Driver) error {
			if err := driver.InTransaction(context.Background(), nil); err == nil {
				return errors.New("nested transaction unexpectedly succeeded")
			}
			return wantErr
		})
		if !errors.Is(err, wantErr) {
			t.Fatalf("InTransaction() = %v, want %v", err, wantErr)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestNilDatabaseAndRuntimeStoreLifecycle(t *testing.T) {
	var database *BunDatabase
	if err := database.Ping(nil); err == nil {
		t.Fatal("Ping(nil) unexpectedly succeeded on nil database")
	}
	if err := database.Exec(nil, "SELECT 1"); err == nil {
		t.Fatal("Exec(nil) unexpectedly succeeded on nil database")
	}
	if _, err := database.Query(nil, "SELECT 1"); err == nil {
		t.Fatal("Query(nil) unexpectedly succeeded on nil database")
	}
	if err := database.InTransaction(nil, nil); err == nil {
		t.Fatal("InTransaction(nil) unexpectedly succeeded on nil database")
	}

	var store *RuntimeStore
	if err := store.Probe(nil); err == nil {
		t.Fatal("Probe(nil) unexpectedly succeeded on nil store")
	}
	if err := store.Close(nil); err != nil {
		t.Fatalf("Close(nil) = %v", err)
	}
	if _, err := OpenRuntimeReadOnly(nil, "not-a-database-url"); err == nil {
		t.Fatal("OpenRuntimeReadOnly accepted an invalid URL")
	}
}
