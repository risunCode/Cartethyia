package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"

	"github.com/cartethyia/daemon/internal/database/migrations"
)

// BunDatabase owns the PostgreSQL pool used by Cartethyia. The sql.DB and Bun
// handles share one connector and are closed together by Close.
type BunDatabase struct {
	sqlDB *sql.DB
	bunDB *bun.DB
}

// OpenBun opens and pings a PostgreSQL database using Bun's official driver.
// It never logs or returns the password contained in cfg.
func OpenBun(ctx context.Context, cfg Config) (*BunDatabase, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if cfg.Host == "" || cfg.Database == "" || cfg.User == "" {
		return nil, errors.New("database: host, user, and database are required")
	}
	connector := pgdriver.NewConnector(pgdriver.WithDSN(cfg.DSN()))
	sqlDB := sql.OpenDB(connector)
	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	bunDB := bun.NewDB(sqlDB, pgdialect.New())
	if err := bunDB.PingContext(ctx); err != nil {
		_ = bunDB.Close()
		return nil, fmt.Errorf("database: ping PostgreSQL: %w", err)
	}
	return &BunDatabase{sqlDB: sqlDB, bunDB: bunDB}, nil
}

// Bun returns the Bun ORM handle for repository construction.
func (d *BunDatabase) Bun() *bun.DB {
	if d == nil {
		return nil
	}
	return d.bunDB
}

// Ping verifies that the PostgreSQL pool can reach its configured server.
// It is intentionally separate from OpenBun so lifecycle readiness can probe
// an already-composed dependency without constructing another client.
func (d *BunDatabase) Ping(ctx context.Context) error {
	if d == nil || d.bunDB == nil {
		return errors.New("database: closed")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return d.bunDB.PingContext(ctx)
}

// Exec implements migrations.Driver for non-query statements.
func (d *BunDatabase) Exec(ctx context.Context, statement string, args ...any) error {
	if d == nil || d.bunDB == nil {
		return errors.New("database: closed")
	}
	_, err := d.bunDB.ExecContext(ctx, statement, args...)
	return err
}

// Query implements migrations.Driver for migration metadata reads.
func (d *BunDatabase) Query(ctx context.Context, statement string, args ...any) (migrations.Rows, error) {
	if d == nil || d.sqlDB == nil {
		return nil, errors.New("database: closed")
	}
	rows, err := d.sqlDB.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	return rowsAdapter{rows: rows}, nil
}

// InTransaction executes fn in one SQL transaction. A failed callback rolls
// back; a successful callback commits. The callback never receives the parent
// database and therefore cannot accidentally escape the transaction boundary.
func (d *BunDatabase) InTransaction(ctx context.Context, fn func(migrations.Driver) error) error {
	if d == nil || d.sqlDB == nil {
		return errors.New("database: closed")
	}
	if fn == nil {
		return errors.New("database: transaction callback is required")
	}
	tx, err := d.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	txDriver := sqlTxDriver{tx: tx}
	if err := fn(txDriver); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Close closes both Bun and the underlying pool. It is safe to call on nil.
func (d *BunDatabase) Close() error {
	if d == nil {
		return nil
	}
	if d.bunDB != nil {
		return d.bunDB.Close()
	}
	if d.sqlDB != nil {
		return d.sqlDB.Close()
	}
	return nil
}

type rowsAdapter struct{ rows *sql.Rows }

func (r rowsAdapter) Next() bool             { return r.rows.Next() }
func (r rowsAdapter) Scan(dest ...any) error { return r.rows.Scan(dest...) }
func (r rowsAdapter) Err() error             { return r.rows.Err() }
func (r rowsAdapter) Close() error           { return r.rows.Close() }

type sqlTxDriver struct{ tx *sql.Tx }

func (d sqlTxDriver) Exec(ctx context.Context, statement string, args ...any) error {
	_, err := d.tx.ExecContext(ctx, statement, args...)
	return err
}

func (d sqlTxDriver) Query(ctx context.Context, statement string, args ...any) (migrations.Rows, error) {
	rows, err := d.tx.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	return rowsAdapter{rows: rows}, nil
}

func (d sqlTxDriver) InTransaction(context.Context, func(migrations.Driver) error) error {
	return errors.New("database: nested transaction is not supported")
}

func (d sqlTxDriver) Close() error { return nil }

var _ migrations.Driver = (*BunDatabase)(nil)
var _ migrations.Driver = sqlTxDriver{}
