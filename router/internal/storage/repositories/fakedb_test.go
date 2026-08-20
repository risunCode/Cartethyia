package repositories

import (
	"database/sql"
	"database/sql/driver"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

// newFakeBun opens a Bun handle over a deterministic sqlmock driver. Query
// matching is regexp-based so repository NewRaw / NewSelect shapes stay
// stable without locking tests to exact whitespace.
func newFakeBun(t *testing.T) (*bun.DB, sqlmock.Sqlmock) {
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

func expectAnyExec(mock sqlmock.Sqlmock, err error) {
	exec := mock.ExpectExec(".*")
	if err != nil {
		exec.WillReturnError(err)
		return
	}
	exec.WillReturnResult(sqlmock.NewResult(1, 1))
}

func expectAnyQueryErr(mock sqlmock.Sqlmock, err error) {
	mock.ExpectQuery(".*").WillReturnError(err)
}

func expectAnyQueryRows(mock sqlmock.Sqlmock, columns []string, values ...[]any) {
	rows := sqlmock.NewRows(columns)
	for _, row := range values {
		vals := make([]driver.Value, len(row))
		for i, v := range row {
			vals[i] = v
		}
		rows.AddRow(vals...)
	}
	mock.ExpectQuery(".*").WillReturnRows(rows)
}

func mustClosed(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected ErrRepositoryClosed")
	}
	if err != ErrRepositoryClosed {
		t.Fatalf("err = %v, want ErrRepositoryClosed", err)
	}
}

func ptr[T any](v T) *T { return &v }

func openSQL(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	return sqlDB, mock
}
