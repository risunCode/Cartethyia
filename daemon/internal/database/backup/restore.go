package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

// ErrRestorePreflight is retained for callers that used the original
// sentinel. CodeOf is the preferred machine-readable classification.
var ErrRestorePreflight = errors.New("backup: restore preflight failed")

const (
	// CurrentManifestSchemaVersion is the only manifest schema this daemon can
	// restore. A future schema must be handled explicitly rather than guessed.
	CurrentManifestSchemaVersion = 1
	maxManifestArchiveName       = 256
	maxManifestSecretRefs        = 256
)

// RestoreManifest is the metadata required to validate and restore an
// archive. SecretRefs contain opaque account references only; raw access,
// refresh, or client secret material is intentionally not representable.
type RestoreManifest struct {
	SchemaVersion int       `json:"schemaVersion"`
	ArchiveName   string    `json:"archiveName"`
	CreatedAt     time.Time `json:"createdAt"`
	Encrypted     bool      `json:"encrypted"`
	SecretRefs    []string  `json:"secretRefs,omitempty"`
}

// Validate checks all manifest fields before any archive or target mutation.
func (m RestoreManifest) Validate() error {
	if m.SchemaVersion <= 0 {
		return codedError(CodeManifestInvalid, errors.New("manifest schema version is required"))
	}
	if m.ArchiveName == "" || len(m.ArchiveName) > maxManifestArchiveName ||
		strings.TrimSpace(m.ArchiveName) != m.ArchiveName ||
		path.Base(m.ArchiveName) != m.ArchiveName ||
		m.ArchiveName == "." || m.ArchiveName == ".." ||
		strings.ContainsAny(m.ArchiveName, `/\`) ||
		strings.IndexFunc(m.ArchiveName, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return codedError(CodeManifestInvalid, errors.New("archive name is invalid"))
	}
	if m.CreatedAt.IsZero() {
		return codedError(CodeManifestInvalid, errors.New("createdAt is required"))
	}
	if len(m.SecretRefs) > maxManifestSecretRefs {
		return codedError(CodeManifestInvalid, errors.New("too many secret references"))
	}
	seen := make(map[string]struct{}, len(m.SecretRefs))
	for _, value := range m.SecretRefs {
		ref, err := accounts.NewReference(value)
		if err != nil {
			return codedError(CodeManifestInvalid, errors.New("secret reference is invalid"))
		}
		if _, ok := seen[ref.String()]; ok {
			return codedError(CodeManifestInvalid, errors.New("duplicate secret reference"))
		}
		seen[ref.String()] = struct{}{}
	}
	return nil
}

// EncodeManifest validates before serializing, ensuring backup output cannot
// accidentally grow a raw-secret field or carry an invalid reference.
func EncodeManifest(m RestoreManifest) ([]byte, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil, codedError(CodeManifestInvalid, err)
	}
	return data, nil
}

// RestoreTarget owns the durable mutation. Implementations must only commit
// after Preflight succeeds and must roll back on a failed Restore call.
type RestoreTarget interface {
	Preflight(context.Context, RestoreManifest) error
	Restore(context.Context, io.Reader, RestoreManifest) error
}

// RestoreSchemaChecker is an optional target capability used to reject a
// valid archive whose database schema is incompatible with the target.
type RestoreSchemaChecker interface {
	SchemaVersion(context.Context) (int, error)
}

// SecretReferenceChecker is an optional target capability. It resolves only
// opaque references and must never return raw secret material to this package.
type SecretReferenceChecker interface {
	CheckSecretReference(context.Context, string) error
}

// MigrationRecovery is an optional target capability for interrupted
// migrations. Recovery runs during restore preflight, before data mutation.
type MigrationRecovery interface {
	Recover(context.Context, int) error
}

// RestoreOutcome reports the exact restore state. Restored is true only after
// Restore returns nil; Partial is true when mutation was attempted but did not
// complete, so callers cannot mistake a failed restore for success.
type RestoreOutcome struct {
	Manifest    RestoreManifest
	PreflightOK bool
	Restored    bool
	Partial     bool
	Err         error
}

// DecodeManifest strictly decodes and validates a manifest. Unknown fields
// are rejected so a caller cannot smuggle raw secret payloads into a backup
// envelope that this package does not understand.
func DecodeManifest(data []byte) (RestoreManifest, error) {
	var m RestoreManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return m, codedError(CodeManifestInvalid, fmt.Errorf("invalid manifest: %w", err))
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return m, codedError(CodeManifestInvalid, errors.New("multiple JSON values"))
		}
		return m, codedError(CodeManifestInvalid, fmt.Errorf("trailing manifest data: %w", err))
	}
	if err := m.Validate(); err != nil {
		return m, err
	}
	return m, nil
}

// Rehearse runs all restore preflight checks and never invokes Restore.
func Rehearse(ctx context.Context, target RestoreTarget, manifest RestoreManifest) RestoreOutcome {
	out := RestoreOutcome{Manifest: manifest}
	if err := restorePreflight(ctx, target, manifest); err != nil {
		out.Err = err
		return out
	}
	out.PreflightOK = true
	return out
}

// Restore validates the manifest, runs preflight, and only then invokes the
// target mutation. A failed mutation is always reported as partial.
func Restore(ctx context.Context, target RestoreTarget, archive io.Reader, manifest RestoreManifest) RestoreOutcome {
	out := RestoreOutcome{Manifest: manifest}
	if err := manifest.Validate(); err != nil {
		out.Err = err
		return out
	}
	if archive == nil {
		out.Err = codedError(CodePreflightFailed, errors.New("archive is required"))
		return out
	}
	out = Rehearse(ctx, target, manifest)
	if out.Err != nil {
		return out
	}
	if err := contextError(ctx); err != nil {
		out.Err = codedError(CodeRestoreCanceled, err)
		return out
	}
	if err := target.Restore(ctx, archive, manifest); err != nil {
		out.Partial = true
		if contextError(ctx) != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			out.Err = codedError(CodeRestoreInterrupted, err)
		} else {
			out.Err = codedError(CodeRestorePartial, err)
		}
		return out
	}
	if err := contextError(ctx); err != nil {
		out.Partial = true
		out.Err = codedError(CodeRestoreInterrupted, err)
		return out
	}
	out.Restored = true
	return out
}

func restorePreflight(ctx context.Context, target RestoreTarget, manifest RestoreManifest) error {
	if target == nil {
		return codedError(CodePreflightFailed, errors.New("restore target is required"))
	}
	if err := contextError(ctx); err != nil {
		return codedError(CodeRestoreCanceled, err)
	}
	if err := manifest.Validate(); err != nil {
		return err
	}
	if recovery, ok := target.(MigrationRecovery); ok {
		if err := recovery.Recover(ctx, manifest.SchemaVersion); err != nil {
			if contextError(ctx) != nil {
				return codedError(CodeRestoreCanceled, err)
			}
			return preserveOrCode(err, CodeMigrationRecovery)
		}
	}
	if checker, ok := target.(RestoreSchemaChecker); ok {
		version, err := checker.SchemaVersion(ctx)
		if err != nil {
			return preserveOrCode(err, CodePreflightFailed)
		}
		if version != manifest.SchemaVersion {
			return codedError(CodeSchemaIncompatible, fmt.Errorf("target schema version %d does not match manifest version %d", version, manifest.SchemaVersion))
		}
	}
	if checker, ok := target.(SecretReferenceChecker); ok {
		for _, ref := range manifest.SecretRefs {
			if err := checker.CheckSecretReference(ctx, ref); err != nil {
				if contextError(ctx) != nil {
					return codedError(CodeRestoreCanceled, err)
				}
				return preserveOrCode(err, CodeSecretReferenceMissing)
			}
		}
	}
	if err := target.Preflight(ctx, manifest); err != nil {
		if contextError(ctx) != nil {
			return codedError(CodeRestoreCanceled, err)
		}
		return preserveOrCode(err, CodePreflightFailed)
	}
	if err := contextError(ctx); err != nil {
		return codedError(CodeRestoreCanceled, err)
	}
	return nil
}

func codedError(code ErrorCode, cause error) error {
	if cause != nil && !errors.Is(cause, ErrRestorePreflight) {
		cause = fmt.Errorf("%w: %v", ErrRestorePreflight, cause)
	}
	return &Error{Code: code, Cause: cause}
}

func preserveOrCode(err error, code ErrorCode) error {
	if CodeOf(err) != "" {
		return err
	}
	return codedError(code, err)
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return errors.New("context is required")
	}
	return ctx.Err()
}
