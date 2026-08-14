package backup

import (
	"context"
	"time"
)

// Status is the terminal state of a backup attempt.
type Status string

const (
	// StatusPending is recorded before a backup begins executing.
	StatusPending Status = "pending"
	// StatusSucceeded is recorded when dump, optional encryption, and upload
	// (when an uploader is wired) all completed without error.
	StatusSucceeded Status = "succeeded"
	// StatusFailed is recorded when any stage returned an error.
	StatusFailed Status = "failed"
)

// Record is the durable description of one backup attempt.
//
// The shape mirrors the rows a future internal/db.BackupRepository is expected
// to persist; only fields relevant to the orchestration layer are kept here so
// the storage package can extend it without coupling backup to admin handlers.
type Record struct {
	// ID is the storage-assigned identifier; zero until Insert assigns one.
	ID int64
	// StartedAt is the moment the dump was launched.
	StartedAt time.Time
	// FinishedAt is the moment the pipeline settled (success or failure).
	FinishedAt time.Time
	// SizeBytes is the size of the produced (optionally encrypted) archive.
	SizeBytes int64
	// Status is the terminal state of the attempt.
	Status Status
	// ErrorStage, when Status is StatusFailed, identifies the failing stage.
	ErrorStage Stage
	// ErrorMessage, when Status is StatusFailed, summarises the error.
	ErrorMessage string
	// Attempt is the 1-based attempt counter.
	Attempt int
}

// MetadataRepository is the narrow contract the backup package needs from a
// storage layer. It is intentionally compatible with the methods a future
// internal/db.BackupRepository exposes so the runtime can wire either
// implementation without a re-mapping layer.
//
// The contract is read/write for the orchestrator only; admin queries and
// cross-table joins belong in the storage package.
type MetadataRepository interface {
	// Insert persists a new record. ID is assigned and the same slice entry
	// is updated in place with the storage-assigned identifier.
	Insert(ctx context.Context, record *Record) error
	// UpdateStatus rewrites the status fields (and FinishedAt) of an existing
	// record. It is a separate call so the orchestrator can record terminal
	// outcomes after a long-running pipeline.
	UpdateStatus(ctx context.Context, id int64, status Status, stage Stage, message string) error
	// ListOlderThan returns records whose StartedAt is strictly before the
	// given cutoff, ordered oldest first. The retention sweep uses it to
	// identify archives that exceed the configured age limit.
	ListOlderThan(ctx context.Context, cutoff time.Time) ([]Record, error)
	// Delete removes a record by ID. Retention uses it after the underlying
	// archive (if any) has been pruned by the uploader.
	Delete(ctx context.Context, id int64) error
}
