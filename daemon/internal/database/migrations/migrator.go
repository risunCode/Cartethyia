package migrations

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Rows is the minimal row iterator required to inspect migration metadata.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close() error
}

// Driver is the minimal SQL surface Migrator requires. Implementations may be
// backed by Bun, database/sql, pgx, or a deterministic test double.
type Driver interface {
	Exec(ctx context.Context, statement string, args ...any) error
	Query(ctx context.Context, statement string, args ...any) (Rows, error)
	InTransaction(ctx context.Context, fn func(Driver) error) error
	Close() error
}

// MigrationStatus describes the current migration state of a database.
type MigrationStatus struct {
	CurrentVersion int
	Pending        []Migration
	Applied        []Migration
}

// MigrationPlan is the deterministic set of migrations that Apply would run.
type MigrationPlan struct {
	ToApply []Migration
	Target  int
}

// MigrationResult is the outcome of Apply.
type MigrationResult struct {
	Applied []Migration
	Final   int
}

// Migrator owns the migration lifecycle for a Cartethyia database.
type Migrator interface {
	Status(ctx context.Context) (MigrationStatus, error)
	Plan(ctx context.Context) (MigrationPlan, error)
	Apply(ctx context.Context) (MigrationResult, error)
}

// SQLMigrator applies ordered migrations through a Driver. The metadata table
// is created in its own transaction, and each migration is atomic within its
// own transaction so a failed step cannot be reported as applied.
type SQLMigrator struct {
	driver     Driver
	migrations []Migration
}

func NewSQLMigrator(driver Driver) *SQLMigrator {
	return &SQLMigrator{driver: driver, migrations: cloneMigrations(All())}
}

func (m *SQLMigrator) Status(ctx context.Context) (MigrationStatus, error) {
	if err := m.validate(); err != nil {
		return MigrationStatus{}, err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return MigrationStatus{}, err
	}
	pending, err := m.pending(applied)
	if err != nil {
		return MigrationStatus{}, err
	}
	return MigrationStatus{
		CurrentVersion: currentVersion(applied),
		Pending:        pending,
		Applied:        applied,
	}, nil
}

func (m *SQLMigrator) Plan(ctx context.Context) (MigrationPlan, error) {
	if err := m.validate(); err != nil {
		return MigrationPlan{}, err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return MigrationPlan{}, err
	}
	pending, err := m.pending(applied)
	if err != nil {
		return MigrationPlan{}, err
	}
	return MigrationPlan{ToApply: pending, Target: len(m.migrations)}, nil
}

func (m *SQLMigrator) Apply(ctx context.Context) (MigrationResult, error) {
	if err := m.validate(); err != nil {
		return MigrationResult{}, err
	}
	if err := contextErr(ctx); err != nil {
		return MigrationResult{}, err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return MigrationResult{}, err
	}
	if len(applied) < len(m.migrations) {
		if err := m.ensureMetadata(ctx); err != nil {
			return MigrationResult{Applied: applied, Final: currentVersion(applied)}, err
		}
	}
	appliedSet := make(map[int]struct{}, len(applied))
	for _, migration := range applied {
		appliedSet[migration.Version] = struct{}{}
	}
	result := MigrationResult{Applied: append([]Migration(nil), applied...), Final: currentVersion(applied)}
	for _, migration := range m.migrations {
		if _, ok := appliedSet[migration.Version]; ok {
			continue
		}
		if err := contextErr(ctx); err != nil {
			return result, err
		}
		err := m.driver.InTransaction(ctx, func(tx Driver) error {
			for _, statement := range migration.Statements {
				if err := contextErr(ctx); err != nil {
					return err
				}
				if err := tx.Exec(ctx, statement); err != nil {
					return fmt.Errorf("migration %d (%s): execute statement: %w", migration.Version, migration.Name, err)
				}
			}
			if err := tx.Exec(ctx, insertMetadataSQL, migration.Version, migration.Name); err != nil {
				return fmt.Errorf("migration %d (%s): record metadata: %w", migration.Version, migration.Name, err)
			}
			return nil
		})
		if err != nil {
			return result, err
		}
		result.Applied = append(result.Applied, migration)
		result.Final = migration.Version
	}
	return result, nil
}

func (m *SQLMigrator) validate() error {
	if m == nil || m.driver == nil {
		return errors.New("migrations: nil driver")
	}
	if len(m.migrations) == 0 {
		return errors.New("migrations: no migrations configured")
	}
	seen := make(map[int]string, len(m.migrations))
	for i, migration := range m.migrations {
		if migration.Version != i+1 {
			if previous, ok := seen[migration.Version]; ok {
				return fmt.Errorf("migrations: duplicate version %d (%s and %s)", migration.Version, previous, migration.Name)
			}
			return fmt.Errorf("migrations: version %d at index %d, want %d", migration.Version, i, i+1)
		}
		if migration.Name == "" {
			return fmt.Errorf("migrations: version %d has empty name", migration.Version)
		}
		if len(migration.Statements) == 0 {
			return fmt.Errorf("migrations: version %d (%s) has no statements", migration.Version, migration.Name)
		}
		seen[migration.Version] = migration.Name
	}
	return nil
}

func (m *SQLMigrator) loadApplied(ctx context.Context) ([]Migration, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	rows, err := m.driver.Query(ctx, selectMetadataSQL)
	if err != nil {
		if isMissingMetadata(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("migrations: load metadata: %w", err)
	}
	defer rows.Close()
	byVersion := make(map[int]Migration)
	for rows.Next() {
		var version int
		var name string
		if err := rows.Scan(&version, &name); err != nil {
			return nil, fmt.Errorf("migrations: scan metadata: %w", err)
		}
		byVersion[version] = Migration{Version: version, Name: name}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("migrations: read metadata: %w", err)
	}
	applied := make([]Migration, 0, len(byVersion))
	for _, migration := range m.migrations {
		if stored, ok := byVersion[migration.Version]; ok {
			if stored.Name != migration.Name {
				return nil, fmt.Errorf("migrations: version %d name mismatch: database=%q configured=%q", migration.Version, stored.Name, migration.Name)
			}
			applied = append(applied, migration)
			delete(byVersion, migration.Version)
		}
	}
	if len(byVersion) != 0 {
		return nil, fmt.Errorf("migrations: database contains unknown version %d", firstVersion(byVersion))
	}
	return applied, nil
}

func (m *SQLMigrator) pending(applied []Migration) ([]Migration, error) {
	appliedSet := make(map[int]struct{}, len(applied))
	for _, migration := range applied {
		appliedSet[migration.Version] = struct{}{}
	}
	pending := make([]Migration, 0, len(m.migrations))
	for _, migration := range m.migrations {
		if _, ok := appliedSet[migration.Version]; !ok {
			pending = append(pending, migration)
		}
	}
	return pending, nil
}

func (m *SQLMigrator) ensureMetadata(ctx context.Context) error {
	return m.driver.InTransaction(ctx, func(tx Driver) error {
		if err := contextErr(ctx); err != nil {
			return err
		}
		return tx.Exec(ctx, createMetadataSQL)
	})
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}

func currentVersion(applied []Migration) int {
	if len(applied) == 0 {
		return 0
	}
	return applied[len(applied)-1].Version
}

func firstVersion(values map[int]Migration) int {
	versions := make([]int, 0, len(values))
	for version := range values {
		versions = append(versions, version)
	}
	sort.Ints(versions)
	return versions[0]
}

func cloneMigrations(values []Migration) []Migration {
	out := make([]Migration, len(values))
	for i, migration := range values {
		out[i] = migration
		out[i].Statements = append([]string(nil), migration.Statements...)
	}
	return out
}

func isMissingMetadata(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "schema_migrations") &&
		(strings.Contains(message, "does not exist") || strings.Contains(message, "undefined table") || strings.Contains(message, "undefined relation"))
}

const createMetadataSQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`

const selectMetadataSQL = `SELECT version, name FROM schema_migrations ORDER BY version;`

const insertMetadataSQL = `INSERT INTO schema_migrations (version, name) VALUES ($1, $2);`
