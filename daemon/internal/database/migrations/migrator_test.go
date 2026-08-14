package migrations

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

// fakeDriver is a deterministic in-memory Driver used to exercise
// SQLMigrator without a real database. The driver records every
// statement, tracks open transactions, and supports forcing errors or
// observing context cancellation between statements.
type fakeDriver struct {
	mu sync.Mutex

	// statements collects Exec calls in invocation order, with their
	// placeholder arguments. A statement prefixed with "FAIL" returns
	// execErr on the next Exec call inside a transaction.
	statements []recordedStmt

	// applied holds versions recorded via the metadata INSERT so
	// loadApplied can return them sorted ASC on the next call.
	applied []Migration

	// metadataExists tracks whether the schema_migrations table is
	// already present; the first SELECT against a missing table
	// returns missingRelationErr, mirroring PostgreSQL.
	metadataExists bool

	// execErr is returned by the next Exec that follows a statement
	// beginning with "FAIL"; cleared after consumption.
	execErr error

	// missingRelationErr is returned by Query when metadataExists is
	// false, so Status treats a fresh database as empty.
	missingRelationErr error

	// hookBeforeExec, if set, runs before each Exec and lets tests
	// assert mid-flight state or cancel the context.
	hookBeforeExec func(ctx context.Context, stmt string)

	// inTxn reports whether the driver is currently inside a
	// transaction (debugging aid; not consulted by SQLMigrator).
	inTxn bool

	// txnCommitted / txnRolledBack record transaction outcomes so
	// rollback semantics can be asserted.
	txnCommitted  int
	txnRolledBack int

	// queryHook, if set, lets tests fail or block Query calls.
	queryHook func(ctx context.Context, stmt string) error
}

type recordedStmt struct {
	stmt string
	args []any
}

func newFakeDriver() *fakeDriver {
	return &fakeDriver{
		missingRelationErr: errors.New(`pq: relation "schema_migrations" does not exist`),
	}
}

func (f *fakeDriver) Exec(ctx context.Context, stmt string, args ...any) error {
	if f.hookBeforeExec != nil {
		f.hookBeforeExec(ctx, stmt)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statements = append(f.statements, recordedStmt{stmt: stmt, args: append([]any(nil), args...)})
	if strings.HasPrefix(strings.TrimSpace(stmt), "FAIL") {
		err := f.execErr
		f.execErr = nil
		return err
	}
	if strings.HasPrefix(strings.TrimSpace(stmt), "INSERT INTO schema_migrations") {
		if len(args) >= 2 {
			ver, _ := args[0].(int)
			name, _ := args[1].(string)
			f.applied = append(f.applied, Migration{Version: ver, Name: name})
		}
		f.metadataExists = true
	}
	return nil
}

func (f *fakeDriver) Query(ctx context.Context, stmt string, args ...any) (Rows, error) {
	if f.queryHook != nil {
		if err := f.queryHook(ctx, stmt); err != nil {
			return nil, err
		}
	}
	if !f.metadataExists {
		return nil, f.missingRelationErr
	}
	f.mu.Lock()
	out := append([]Migration(nil), f.applied...)
	f.mu.Unlock()
	return &fakeRows{rows: out}, nil
}

func (f *fakeDriver) InTransaction(ctx context.Context, fn func(Driver) error) error {
	f.mu.Lock()
	if f.inTxn {
		f.mu.Unlock()
		return errors.New("fakeDriver: nested transaction not supported")
	}
	f.inTxn = true
	f.mu.Unlock()
	err := fn(f)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inTxn = false
	if err != nil {
		f.txnRolledBack++
	} else {
		f.txnCommitted++
	}
	return err
}

func (f *fakeDriver) Close() error { return nil }

// failNext sets execErr so the next FAIL-prefixed Exec returns it.
func (f *fakeDriver) failNext(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execErr = err
}

// statementCount returns the number of recorded Exec calls so tests can
// assert that failure paths did not execute additional statements.
func (f *fakeDriver) statementCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.statements)
}

// rollbackCount / commitCount expose transaction outcomes.
func (f *fakeDriver) rollbackCount() int { f.mu.Lock(); defer f.mu.Unlock(); return f.txnRolledBack }
func (f *fakeDriver) commitCount() int   { f.mu.Lock(); defer f.mu.Unlock(); return f.txnCommitted }

// appliedVersions returns the recorded schema_migrations versions.
func (f *fakeDriver) appliedVersions() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]int, len(f.applied))
	for i, m := range f.applied {
		out[i] = m.Version
	}
	return out
}

// fakeRows is a Rows implementation backed by an in-memory slice.
type fakeRows struct {
	rows []Migration
	idx  int
	err  error
	done bool
}

func (r *fakeRows) Next() bool {
	if r.done {
		return false
	}
	if r.idx >= len(r.rows) {
		r.done = true
		return false
	}
	r.idx++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return errors.New("fakeRows: scan without next")
	}
	row := r.rows[r.idx-1]
	if len(dest) >= 2 {
		if v, ok := dest[0].(*int); ok {
			*v = row.Version
		}
		if v, ok := dest[1].(*string); ok {
			*v = row.Name
		}
	}
	return r.err
}

func (r *fakeRows) Err() error { return r.err }
func (r *fakeRows) Close() error {
	r.done = true
	return nil
}

// successDriver is a Driver that always succeeds; it does not record
// anything. It is used to verify Status() and Plan() on a fresh database.
type successDriver struct {
	fake *fakeDriver
}

func (s *successDriver) Exec(ctx context.Context, stmt string, args ...any) error { return nil }
func (s *successDriver) Query(ctx context.Context, stmt string, args ...any) (Rows, error) {
	return &fakeRows{}, nil
}
func (s *successDriver) InTransaction(ctx context.Context, fn func(Driver) error) error { return fn(s) }
func (s *successDriver) Close() error                                                   { return nil }

// --- tests --------------------------------------------------------------

// TestApplyFreshDatabaseAppliesAllMigrations verifies the happy path:
// every pending migration is run inside its own transaction and the
// final version matches the highest pending version.
func TestApplyFreshDatabaseAppliesAllMigrations(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	res, err := mig.Apply(context.Background())
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := len(All())
	if len(res.Applied) != want {
		t.Fatalf("Applied count = %d, want %d", len(res.Applied), want)
	}
	if res.Final != want {
		t.Fatalf("Final = %d, want %d", res.Final, want)
	}
	if got := drv.commitCount(); got != want+1 {
		t.Fatalf("committed transactions = %d, want %d (metadata + %d migrations)", got, want+1, want)
	}
	if drv.rollbackCount() != 0 {
		t.Fatalf("rolled back transactions = %d, want 0", drv.rollbackCount())
	}
}

// TestApplyIsIdempotent verifies that running Apply twice on the same
// driver leaves the schema unchanged: the second call is a no-op and
// reports zero new migrations.
func TestApplyIsIdempotent(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	first, err := mig.Apply(context.Background())
	if err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	if first.Final != len(All()) {
		t.Fatalf("first Apply Final = %d, want %d", first.Final, len(All()))
	}

	stmtsAfterFirst := drv.statementCount()

	second, err := mig.Apply(context.Background())
	if err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	if len(second.Applied) != len(All()) {
		t.Fatalf("second Applied count = %d, want %d (full history, no new work)", len(second.Applied), len(All()))
	}
	if second.Final != first.Final {
		t.Fatalf("second Final = %d, want %d", second.Final, first.Final)
	}
	if got := drv.statementCount(); got != stmtsAfterFirst {
		t.Fatalf("second Apply executed %d new statements, want 0", got-stmtsAfterFirst)
	}
}

// TestApplyRollsBackFailedMigration verifies that a statement failure
// rolls back the in-flight migration: no metadata row is recorded, no
// subsequent migrations run, and the result reflects the partial state
// the database actually has.
func TestApplyRollsBackFailedMigration(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	// Inject a failure on the first migration's only statement. The
	// statement is rewritten to begin with "FAIL" so the fake driver's
	// Exec returns execErr.
	mig.migrations[0] = Migration{
		Version: 1,
		Name:    "broken",
		Statements: []string{
			"FAIL CREATE TABLE broken (id INT);",
		},
	}
	drv.failNext(errors.New("syntax error"))

	res, err := mig.Apply(context.Background())
	if err == nil {
		t.Fatal("Apply returned nil error, want a failure")
	}
	if !strings.Contains(err.Error(), "broken") {
		t.Fatalf("error %q does not name the failing migration", err)
	}
	if len(res.Applied) != 0 {
		t.Fatalf("Applied = %d, want 0 after rollback", len(res.Applied))
	}
	if res.Final != 0 {
		t.Fatalf("Final = %d, want 0 after rollback", res.Final)
	}
	if got := drv.rollbackCount(); got < 1 {
		t.Fatalf("rolled back transactions = %d, want >= 1", got)
	}
	if got := drv.appliedVersions(); len(got) != 0 {
		t.Fatalf("recorded metadata versions = %v, want none after rollback", got)
	}
}

// TestApplyHaltsOnContextCancellation verifies that a cancelled context
// stops work mid-migration and reports the cancellation as the error.
func TestApplyHaltsOnContextCancellation(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	ctx, cancel := context.WithCancel(context.Background())
	drv.hookBeforeExec = func(c context.Context, stmt string) {
		if strings.HasPrefix(strings.TrimSpace(stmt), "INSERT INTO schema_migrations") {
			cancel()
		}
	}

	res, err := mig.Apply(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Apply error = %v, want context.Canceled", err)
	}
	// The migration that triggered cancellation had its metadata row
	// already inserted by the fake driver before the hook fires, so
	// the recorded version reflects the in-flight migration. The
	// The critical invariant is that no further migration is applied after
	// cancellation. A cancellation before the first metadata insert may leave
	// the applied list empty, which is a valid rolled-back outcome.
	applied := drv.appliedVersions()
	if len(applied) >= len(All()) {
		t.Fatalf("Apply continued past cancellation: applied %d/%d", len(applied), len(All()))
	}
	if len(applied) > 0 && res.Final != applied[len(applied)-1] {
		t.Fatalf("Final = %d does not match last recorded version %d", res.Final, applied[len(applied)-1])
	}
}

// TestApplyRejectsDuplicateVersions verifies the validation path: a
// migration list with two entries sharing a version fails Apply with a
// deterministic error instead of silently re-running the row.
func TestApplyRejectsDuplicateVersions(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	mig.migrations = []Migration{
		{Version: 1, Name: "a", Statements: []string{"CREATE TABLE a (id INT);"}},
		{Version: 1, Name: "dup", Statements: []string{"CREATE TABLE dup (id INT);"}},
		{Version: 2, Name: "c", Statements: []string{"CREATE TABLE c (id INT);"}},
	}

	res, err := mig.Apply(context.Background())
	if err == nil {
		t.Fatal("Apply returned nil error, want duplicate-version failure")
	}
	if !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("error %q does not mention duplicates", err)
	}
	if len(res.Applied) != 0 {
		t.Fatalf("Applied = %d, want 0 after validation failure", len(res.Applied))
	}
}

// TestApplyRejectsOutOfOrderVersions verifies that a migration list
// whose versions skip ahead fails Apply with a deterministic error so
// the schema never ends up with a gap.
func TestApplyRejectsOutOfOrderVersions(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	mig.migrations = []Migration{
		{Version: 1, Name: "a", Statements: []string{"CREATE TABLE a (id INT);"}},
		// Version 2 is missing.
		{Version: 3, Name: "c", Statements: []string{"CREATE TABLE c (id INT);"}},
	}

	_, err := mig.Apply(context.Background())
	if err == nil {
		t.Fatal("Apply returned nil error, want ordering failure")
	}
	if !strings.Contains(err.Error(), "version") {
		t.Fatalf("error %q does not mention version ordering", err)
	}
	if got := drv.appliedVersions(); len(got) != 0 {
		t.Fatalf("recorded metadata versions = %v, want none on ordering failure", got)
	}
}

// TestApplyRejectsEmptyStatements verifies that a migration whose
// Statements slice is empty fails validation rather than running an
// empty transaction.
func TestApplyRejectsEmptyStatements(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	mig.migrations = []Migration{
		{Version: 1, Name: "no_statements", Statements: nil},
	}

	_, err := mig.Apply(context.Background())
	if err == nil {
		t.Fatal("Apply returned nil error, want empty-statements failure")
	}
	if !strings.Contains(err.Error(), "statements") {
		t.Fatalf("error %q does not mention statements", err)
	}
}

// TestStatusOnFreshDatabaseReportsAllPending verifies Status() on a
// database that has never been migrated: CurrentVersion is 0 and
// every migration appears in Pending.
func TestStatusOnFreshDatabaseReportsAllPending(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	status, err := mig.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.CurrentVersion != 0 {
		t.Fatalf("CurrentVersion = %d, want 0", status.CurrentVersion)
	}
	if len(status.Applied) != 0 {
		t.Fatalf("Applied = %d, want 0", len(status.Applied))
	}
	if len(status.Pending) != len(All()) {
		t.Fatalf("Pending = %d, want %d", len(status.Pending), len(All()))
	}
}

// TestStatusAfterApplyReportsAllAppliedAndNoPending verifies Status()
// after Apply(): Pending is empty and every migration is in Applied,
// with CurrentVersion set to the highest applied version.
func TestStatusAfterApplyReportsAllAppliedAndNoPending(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	if _, err := mig.Apply(context.Background()); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	status, err := mig.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(status.Pending) != 0 {
		t.Fatalf("Pending = %d, want 0", len(status.Pending))
	}
	if len(status.Applied) != len(All()) {
		t.Fatalf("Applied = %d, want %d", len(status.Applied), len(All()))
	}
	if status.CurrentVersion != len(All()) {
		t.Fatalf("CurrentVersion = %d, want %d", status.CurrentVersion, len(All()))
	}
}

// TestPlanReturnsEmptyWhenUpToDate verifies that Plan() on a fully
// applied database reports nothing to apply.
func TestPlanReturnsEmptyWhenUpToDate(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	if _, err := mig.Apply(context.Background()); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	plan, err := mig.Plan(context.Background())
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(plan.ToApply) != 0 {
		t.Fatalf("ToApply = %d, want 0", len(plan.ToApply))
	}
	if plan.Target != len(All()) {
		t.Fatalf("Target = %d, want %d", plan.Target, len(All()))
	}
}

// TestPlanReturnsAllPendingOnFreshDatabase verifies that Plan() on a
// fresh database returns every migration in ToApply and the target is
// the highest version.
func TestPlanReturnsAllPendingOnFreshDatabase(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	plan, err := mig.Plan(context.Background())
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(plan.ToApply) != len(All()) {
		t.Fatalf("ToApply = %d, want %d", len(plan.ToApply), len(All()))
	}
	if plan.Target != len(All()) {
		t.Fatalf("Target = %d, want %d", plan.Target, len(All()))
	}
	for i, m := range plan.ToApply {
		if m.Version != i+1 {
			t.Fatalf("ToApply[%d].Version = %d, want %d", i, m.Version, i+1)
		}
	}
}

// TestNilDriverReturnsError verifies that constructing and using a
// migrator without a driver fails fast with a deterministic error.
func TestNilDriverReturnsError(t *testing.T) {
	mig := NewSQLMigrator(nil)
	if _, err := mig.Status(context.Background()); err == nil {
		t.Fatal("Status with nil driver returned nil error")
	}
	if _, err := mig.Apply(context.Background()); err == nil {
		t.Fatal("Apply with nil driver returned nil error")
	}
}

// TestContextCancelledBeforeApply verifies that a context already
// cancelled before Apply runs short-circuits without touching the
// driver.
func TestContextCancelledBeforeApply(t *testing.T) {
	drv := newFakeDriver()
	mig := NewSQLMigrator(drv)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := mig.Apply(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Apply = %v, want context.Canceled", err)
	}
	if got := drv.statementCount(); got != 0 {
		t.Fatalf("executed %d statements on cancelled context, want 0", got)
	}
}

// TestAllMigrationsAreOrderedAndUnique verifies the package invariant
// that All() returns strictly increasing, gap-free versions.
func TestAllMigrationsAreOrderedAndUnique(t *testing.T) {
	seen := make(map[int]string)
	for i, mig := range All() {
		if _, dup := seen[mig.Version]; dup {
			t.Fatalf("duplicate version %d in All()", mig.Version)
		}
		seen[mig.Version] = mig.Name
		if mig.Version != i+1 {
			t.Fatalf("All()[%d].Version = %d, want %d", i, mig.Version, i+1)
		}
		if len(mig.Statements) == 0 {
			t.Fatalf("All()[%d] (%s) has no statements", i, mig.Name)
		}
		if mig.Name == "" {
			t.Fatalf("All()[%d] has empty name", i)
		}
	}
}
