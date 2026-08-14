package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type restoreFixture struct {
	preflight bool
	restored  bool
}

func (f *restoreFixture) Preflight(context.Context, RestoreManifest) error {
	f.preflight = true
	return nil
}
func (f *restoreFixture) Restore(_ context.Context, r io.Reader, _ RestoreManifest) error {
	f.restored = true
	_, _ = io.ReadAll(r)
	return nil
}
func TestRestoreRequiresValidManifest(t *testing.T) {
	if _, err := DecodeManifest([]byte(`{"schemaVersion":0}`)); !errors.Is(err, ErrRestorePreflight) {
		t.Fatalf("err=%v", err)
	}
}
func TestRestoreRunsPreflightBeforeMutation(t *testing.T) {
	f := &restoreFixture{}
	m := RestoreManifest{SchemaVersion: 1, ArchiveName: "a", CreatedAt: time.Now()}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), m)
	if out.Err != nil || !out.PreflightOK || !out.Restored || !f.preflight || !f.restored {
		t.Fatalf("out=%#v fixture=%#v", out, f)
	}
	if strings.Contains(out.Manifest.ArchiveName, "secret") {
		t.Fatal("bad manifest")
	}
}

type recoveryRestoreFixture struct {
	restoreFixture
	schema       int
	recoverCalls int
	recoverErr   error
	secretRefs   map[string]bool
	restoreErr   error
	restoreHook  func()
}

func (f *recoveryRestoreFixture) SchemaVersion(context.Context) (int, error) {
	return f.schema, nil
}
func (f *recoveryRestoreFixture) Recover(context.Context, int) error {
	f.recoverCalls++
	return f.recoverErr
}

func (f *recoveryRestoreFixture) CheckSecretReference(_ context.Context, ref string) error {
	if f.secretRefs[ref] {
		return nil
	}
	return errors.New("not found")
}

func (f *recoveryRestoreFixture) Restore(ctx context.Context, r io.Reader, _ RestoreManifest) error {
	f.restored = true
	if f.restoreHook != nil {
		f.restoreHook()
	}
	_, _ = io.ReadAll(r)
	if f.restoreErr != nil {
		return f.restoreErr
	}
	return ctx.Err()
}

func validManifest() RestoreManifest {
	return RestoreManifest{
		SchemaVersion: CurrentManifestSchemaVersion,
		ArchiveName:   "cartethyia.dump",
		CreatedAt:     time.Unix(1, 0).UTC(),
	}
}

func TestRestoreCleanRestoreRunsMigrationRecovery(t *testing.T) {
	f := &recoveryRestoreFixture{schema: CurrentManifestSchemaVersion}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), validManifest())
	if out.Err != nil || !out.PreflightOK || !out.Restored || out.Partial {
		t.Fatalf("out=%#v", out)
	}
	if f.recoverCalls != 1 {
		t.Fatalf("migration recovery calls=%d, want 1", f.recoverCalls)
	}
}

func TestRestoreReportsMigrationRecoveryFailure(t *testing.T) {
	f := &recoveryRestoreFixture{
		schema:     CurrentManifestSchemaVersion,
		recoverErr: errors.New("migration metadata is interrupted"),
	}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), validManifest())
	if out.Err == nil || CodeOf(out.Err) != CodeMigrationRecovery {
		t.Fatalf("err=%v code=%q", out.Err, CodeOf(out.Err))
	}
	if out.PreflightOK || out.Restored || out.Partial {
		t.Fatalf("migration recovery failure was reported as success: %#v", out)
	}
}

func TestRestoreRejectsIncompatibleSchemaBeforeMutation(t *testing.T) {
	f := &recoveryRestoreFixture{schema: CurrentManifestSchemaVersion + 1}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), validManifest())
	if out.Err == nil || CodeOf(out.Err) != CodeSchemaIncompatible {
		t.Fatalf("err=%v code=%q", out.Err, CodeOf(out.Err))
	}
	if out.PreflightOK || out.Restored || f.restored {
		t.Fatalf("restore mutated despite incompatible schema: %#v fixture=%#v", out, f)
	}
}

func TestRestoreRejectsMissingSecretReferenceBeforeMutation(t *testing.T) {
	f := &recoveryRestoreFixture{
		schema:     CurrentManifestSchemaVersion,
		secretRefs: map[string]bool{"credential-ref": true},
	}
	m := validManifest()
	m.SecretRefs = []string{"missing-ref"}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), m)
	if out.Err == nil || CodeOf(out.Err) != CodeSecretReferenceMissing {
		t.Fatalf("err=%v code=%q", out.Err, CodeOf(out.Err))
	}
	if out.PreflightOK || out.Restored || f.restored {
		t.Fatalf("restore mutated despite missing reference: %#v fixture=%#v", out, f)
	}
}

func TestRestoreReportsInterruptedAndPartialFailure(t *testing.T) {
	f := &recoveryRestoreFixture{
		schema:     CurrentManifestSchemaVersion,
		restoreErr: errors.New("transaction rolled back"),
	}
	out := Restore(context.Background(), f, bytes.NewBufferString("archive"), validManifest())
	if out.Err == nil || CodeOf(out.Err) != CodeRestorePartial {
		t.Fatalf("err=%v code=%q", out.Err, CodeOf(out.Err))
	}
	if !out.PreflightOK || out.Restored || !out.Partial {
		t.Fatalf("partial restore was reported as success: %#v", out)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out = Restore(ctx, f, bytes.NewBufferString("archive"), validManifest())
	if out.Err == nil || CodeOf(out.Err) != CodeRestoreCanceled || out.Partial {
		t.Fatalf("canceled preflight=%#v", out)
	}
}

func TestRestoreReportsInterruptedMutationOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := &recoveryRestoreFixture{
		schema:      CurrentManifestSchemaVersion,
		restoreHook: cancel,
	}
	out := Restore(ctx, f, bytes.NewBufferString("archive"), validManifest())
	if out.Err == nil || CodeOf(out.Err) != CodeRestoreInterrupted {
		t.Fatalf("err=%v code=%q", out.Err, CodeOf(out.Err))
	}
	if !out.PreflightOK || out.Restored || !out.Partial {
		t.Fatalf("interrupted restore was not reported truthfully: %#v", out)
	}
}

func TestManifestEncodingContainsOnlyOpaqueSecretReferences(t *testing.T) {
	m := validManifest()
	m.SecretRefs = []string{"credential-ref"}
	data, err := EncodeManifest(m)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(data), "raw-token") || strings.Contains(string(data), "access-token") {
		t.Fatalf("manifest contains raw secret material: %s", data)
	}
	if !strings.Contains(string(data), "credential-ref") {
		t.Fatalf("manifest omitted reference: %s", data)
	}
}
