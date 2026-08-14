package backup

import (
	"errors"
	"fmt"
	"time"
)

// Stage tags the part of the backup pipeline that produced an error.
type Stage string

const (
	// StageDump covers pg_dump command execution.
	StageDump Stage = "dump"
	// StageEncrypt covers streaming encryption of the dump.
	StageEncrypt Stage = "encrypt"
	// StageUpload covers the Telegram sendDocument call.
	StageUpload Stage = "upload"
	// StageRetention covers pruning of older backup records.
	StageRetention Stage = "retention"
	// StageReport covers sending the failure summary to the operator.
	StageReport Stage = "report"
	// StageMetadata covers persistence of backup records to storage.
	StageMetadata Stage = "metadata"
)

// ErrorCode is the stable machine-readable classification of a backup
// failure. Error text is diagnostic only and must not be parsed by callers.
type ErrorCode string

const (
	CodeManifestInvalid        ErrorCode = "backup.manifest_invalid"
	CodeSchemaIncompatible     ErrorCode = "backup.schema_incompatible"
	CodeSecretReferenceMissing ErrorCode = "backup.secret_reference_missing"
	CodePreflightFailed        ErrorCode = "backup.preflight_failed"
	CodeRestoreCanceled        ErrorCode = "backup.restore_canceled"
	CodeRestoreInterrupted     ErrorCode = "backup.restore_interrupted"
	CodeRestorePartial         ErrorCode = "backup.restore_partial"
	CodeRestoreFailed          ErrorCode = "backup.restore_failed"
	CodeMigrationRecovery      ErrorCode = "backup.migration_recovery_failed"
	CodeDumpFailed             ErrorCode = "backup.dump_failed"
	CodeEncryptFailed          ErrorCode = "backup.encrypt_failed"
	CodeUploadFailed           ErrorCode = "backup.upload_failed"
	CodeRetentionFailed        ErrorCode = "backup.retention_failed"
	CodeReportFailed           ErrorCode = "backup.report_failed"
	CodeMetadataFailed         ErrorCode = "backup.metadata_failed"
)

// Error describes a failure tagged with the pipeline stage and, when
// applicable, a stable backup-owned code.
type Error struct {
	Code  ErrorCode
	Stage Stage
	// Attempt is the 1-based attempt number for retryable stages.
	Attempt int
	// Cause is the wrapped error.
	Cause error
}

// Error implements the error interface.
func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	prefix := "backup"
	if e.Code != "" {
		prefix = string(e.Code)
	} else if e.Stage != "" {
		prefix = fmt.Sprintf("backup %s", e.Stage)
	}
	if e.Cause == nil {
		if e.Attempt > 0 {
			return fmt.Sprintf("%s: attempt %d", prefix, e.Attempt)
		}
		return prefix
	}
	if e.Attempt > 0 {
		return fmt.Sprintf("%s: attempt %d: %v", prefix, e.Attempt, e.Cause)
	}
	return fmt.Sprintf("%s: %v", prefix, e.Cause)
}

// CodeString returns the stable code as a string for wire adapters.
func (e *Error) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

// Unwrap exposes the wrapped error for errors.Is / errors.As.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Is supports comparison with another *Error by stable code when the target
// supplies one, falling back to the historical stage comparison.
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	if !ok || other == nil {
		return false
	}
	if other.Code != "" {
		return e.Code != "" && e.Code == other.Code
	}
	if other.Stage != "" {
		return e.Stage == other.Stage
	}
	return e.Code == other.Code && e.Stage == other.Stage
}

// CodeOf extracts a backup-owned machine-readable code from a wrapped error.
// It returns the empty code for legacy errors that predate coded failures.
func CodeOf(err error) ErrorCode {
	var coded *Error
	if errors.As(err, &coded) && coded != nil {
		return coded.Code
	}
	return ""
}

// ErrCancelled is returned when the supplied context is cancelled mid-pipeline.
var ErrCancelled = errors.New("backup cancelled")

// ErrNoUploader is returned when an upload is requested but no uploader is wired.
var ErrNoUploader = errors.New("backup: no uploader configured")

// ErrNoReporter is returned when a failure report is requested but no reporter
// is wired.
var ErrNoReporter = errors.New("backup: no failure reporter configured")

// newStageError constructs a tagged error with a stable stage code.
func newStageError(stage Stage, attempt int, cause error) error {
	return &Error{Code: stageCode(stage), Stage: stage, Attempt: attempt, Cause: cause}
}

func stageCode(stage Stage) ErrorCode {
	switch stage {
	case StageDump:
		return CodeDumpFailed
	case StageEncrypt:
		return CodeEncryptFailed
	case StageUpload:
		return CodeUploadFailed
	case StageRetention:
		return CodeRetentionFailed
	case StageReport:
		return CodeReportFailed
	case StageMetadata:
		return CodeMetadataFailed
	default:
		return ""
	}
}

// Timestamp is a UTC time helper used by the report and metadata layers.
type Timestamp time.Time

// now returns the current UTC time; tests can override via Service.now.
var now = func() time.Time { return time.Now().UTC() }
