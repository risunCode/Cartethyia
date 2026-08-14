package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Schedule describes the cadence at which the orchestrator launches dumps.
type Schedule struct {
	// Interval is the delay between consecutive runs. Must be > 0.
	Interval time.Duration
	// MaxAttempts is the per-run retry cap for retryable stages. 0 means no
	// retries (a single attempt). Each retry re-runs the entire pipeline so
	// the caller can apply backoff between attempts.
	MaxAttempts int
	// RetentionAge is the maximum age a backup record may reach before the
	// retention sweep deletes it. Zero disables retention.
	RetentionAge time.Duration
}

// Validate sanity-checks the schedule.
func (s Schedule) Validate() error {
	if s.Interval <= 0 {
		return errors.New("backup: Schedule.Interval must be positive")
	}
	if s.MaxAttempts < 0 {
		return errors.New("backup: Schedule.MaxAttempts must be non-negative")
	}
	if s.RetentionAge < 0 {
		return errors.New("backup: Schedule.RetentionAge must be non-negative")
	}
	return nil
}

// Service is the top-level backup orchestrator. It owns the lifecycle of a
// scheduled dump loop, a retention sweep, and the failure reporting path.
//
// Service does not own any I/O of its own; every external dependency is
// supplied at construction. Start is safe to call once; subsequent calls
// return an error.
type Service struct {
	Dumper   Dumper
	Encrypt  Encryptor
	Uploader Uploader
	Metadata MetadataRepository
	Reporter FailureReporter
	Schedule Schedule

	// Now is a clock injection point used for record timestamps. nil falls
	// back to time.Now.UTC.
	Now func() time.Time

	// ReportOnPartial is retained for compatibility. Partial archive creation
	// is always reported as failure; this field no longer permits success when
	// delivery is absent.
	ReportOnPartial bool

	mu      sync.Mutex
	running bool
	stop    chan struct{}
	done    chan struct{}
}

// New constructs a Service from caller-supplied dependencies. It does not
// validate the schedule; call Start to begin the loop, which surfaces
// configuration errors before the first run.
func New(schedule Schedule, dumper Dumper, encrypt Encryptor, uploader Uploader, metadata MetadataRepository, reporter FailureReporter) *Service {
	return &Service{
		Dumper:   dumper,
		Encrypt:  encrypt,
		Uploader: uploader,
		Metadata: metadata,
		Reporter: reporter,
		Schedule: schedule,
		Now:      func() time.Time { return time.Now().UTC() },
	}
}

// Start launches the scheduled loop. The loop runs RunOnce at every tick of
// Schedule.Interval. The returned error is the validation error; once the
// loop is running, runtime failures are reported via the FailureReporter and
// recorded in metadata.
//
// Cancel ctx to stop the loop; Stop blocks until the in-flight run finishes.
func (s *Service) Start(ctx context.Context) error {
	if err := s.Schedule.Validate(); err != nil {
		return err
	}
	if s.Dumper == nil {
		return errors.New("backup: Service.Dumper is nil")
	}
	if s.Metadata == nil {
		return errors.New("backup: Service.Metadata is nil")
	}

	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return errors.New("backup: Service already started")
	}
	s.running = true
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	s.mu.Unlock()

	go s.loop(ctx)
	return nil
}

// Stop signals the loop to exit and waits for the in-flight run to finish.
func (s *Service) Stop() {
	s.mu.Lock()
	stop := s.stop
	done := s.done
	running := s.running
	s.running = false
	s.mu.Unlock()
	if !running || stop == nil {
		return
	}
	close(stop)
	if done != nil {
		<-done
	}
}

func (s *Service) loop(ctx context.Context) {
	defer close(s.done)
	ticker := time.NewTicker(s.Schedule.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-ticker.C:
			runCtx, cancel := context.WithCancel(ctx)
			s.RunOnce(runCtx)
			cancel()
		}
	}
}

// RunOutcome is the observable result of a single backup attempt.
type RunOutcome struct {
	// Record is the persisted metadata entry.
	Record Record
	// Err is the terminal error (nil on success).
	Err error
	// Result is the upload result, when the uploader was wired and ran.
	Result UploadResult
	// ArchiveName is the produced archive name (including extension when
	// the encryptor was wired). Empty when the dump stage failed.
	ArchiveName string
}

// RunOnce performs one full pipeline: dump -> (optional) encrypt -> (optional)
// upload -> record persistence. It records the attempt in metadata and, on
// failure, dispatches a failure report if a reporter is configured.
//
// RunOnce is safe to call concurrently with the scheduled loop; each call
// uses its own context and metadata record.
func (s *Service) RunOnce(ctx context.Context) RunOutcome {
	started := s.now()
	record := Record{
		StartedAt: started,
		Status:    StatusPending,
		Attempt:   1,
	}
	if s.Metadata != nil {
		if err := s.Metadata.Insert(ctx, &record); err != nil {
			// Without a record we cannot reliably report; the operator sees
			// this in the process log only.
			return RunOutcome{Record: record, Err: newStageError(StageMetadata, 1, fmt.Errorf("insert: %w", err))}
		}
	}

	maxAttempts := s.Schedule.MaxAttempts + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	var (
		outcomeErr   error
		uploadResult UploadResult
		archiveSize  int64
		archiveName  string
	)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		record.Attempt = attempt
		archiveName, archiveSize, uploadResult, outcomeErr = s.runAttempt(ctx, attempt)
		if outcomeErr == nil {
			break
		}
		if ctx.Err() != nil {
			outcomeErr = newStageError(stageOf(outcomeErr), attempt, ctx.Err())
			break
		}
	}
	if outcomeErr != nil {
		record.FinishedAt = s.now()
		record.SizeBytes = archiveSize
		record.Status = StatusFailed
		record.ErrorStage = stageOf(outcomeErr)
		record.ErrorMessage = outcomeErr.Error()
		if s.Metadata != nil {
			_ = s.Metadata.UpdateStatus(ctx, record.ID, record.Status, record.ErrorStage, record.ErrorMessage)
		}
		s.dispatchFailureReport(ctx, record, outcomeErr)
		return RunOutcome{Record: record, Err: outcomeErr, ArchiveName: archiveName}
	}

	record.FinishedAt = s.now()
	record.Status = StatusSucceeded
	record.SizeBytes = archiveSize
	if s.Metadata != nil {
		if err := s.Metadata.UpdateStatus(ctx, record.ID, record.Status, "", ""); err != nil {
			outcomeErr = newStageError(StageMetadata, record.Attempt, fmt.Errorf("update success status: %w", err))
			record.Status = StatusFailed
			record.ErrorStage = StageMetadata
			record.ErrorMessage = outcomeErr.Error()
			s.dispatchFailureReport(ctx, record, outcomeErr)
			return RunOutcome{Record: record, Result: uploadResult, Err: outcomeErr, ArchiveName: archiveName}
		}
	}
	return RunOutcome{Record: record, Result: uploadResult, ArchiveName: archiveName}
}

// runAttempt executes one pipeline iteration and returns the produced archive
// name, size, upload result, and any error. The error is stage-tagged via
// newStageError so callers can classify it.
func (s *Service) runAttempt(ctx context.Context, attempt int) (string, int64, UploadResult, error) {
	dumpReader, err := s.Dumper.Dump(ctx)
	if err != nil {
		return "", 0, UploadResult{}, err
	}
	defer dumpReader.Close()

	var archive io.ReadCloser
	if s.Encrypt != nil {
		encrypted, eerr := s.Encrypt.Encrypt(ctx, dumpReader)
		if eerr != nil {
			return "", 0, UploadResult{}, eerr
		}
		archive = encrypted
	} else {
		archive = dumpReader
	}
	defer archive.Close()

	counted := newCountingReader(archive)

	// Deterministic name based on the dump's start time. Extension is
	// appended only when an encryptor is configured.
	name := fmt.Sprintf("cartethyia-%s.dump", s.now().Format("20060102T150405Z"))
	if s.Encrypt != nil {
		name += s.Encrypt.Extension()
	}

	if s.Uploader == nil {
		_, _ = io.Copy(io.Discard, counted)
		// Producing an archive without delivering it is a partial backup, not
		// success. ReportOnPartial is retained for source compatibility but
		// no longer permits a false-success metadata record.
		return name, counted.N, UploadResult{}, newStageError(StageUpload, attempt, ErrNoUploader)
	}

	result, err := s.Uploader.Upload(ctx, name, counted, -1)
	if err != nil {
		return name, counted.N, UploadResult{}, err
	}
	return name, counted.N, result, nil
}

// dispatchFailureReport sends a failure summary through the configured
// reporter, if any. Report failures do not propagate to the caller; the
// orchestrator continues regardless because the underlying backup failure
// has already been recorded in metadata.
func (s *Service) dispatchFailureReport(ctx context.Context, record Record, cause error) {
	if s.Reporter == nil {
		return
	}
	report := FailureReport{
		Stage:      record.ErrorStage,
		Message:    cause.Error(),
		Attempt:    record.Attempt,
		OccurredAt: record.FinishedAt,
	}
	if report.OccurredAt.IsZero() {
		report.OccurredAt = s.now()
	}
	_ = s.Reporter.Report(ctx, report)
}

// SweepRetention deletes metadata rows older than Schedule.RetentionAge. The
// call is a no-op when retention is disabled (RetentionAge == 0) or when
// no metadata repository is wired.
func (s *Service) SweepRetention(ctx context.Context) error {
	if s.Schedule.RetentionAge <= 0 || s.Metadata == nil {
		return nil
	}
	cutoff := s.now().Add(-s.Schedule.RetentionAge)
	rows, err := s.Metadata.ListOlderThan(ctx, cutoff)
	if err != nil {
		return newStageError(StageRetention, 1, fmt.Errorf("list: %w", err))
	}
	for _, row := range rows {
		if err := s.Metadata.Delete(ctx, row.ID); err != nil {
			return newStageError(StageRetention, 1, fmt.Errorf("delete %d: %w", row.ID, err))
		}
	}
	return nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func stageOf(err error) Stage {
	if err == nil {
		return ""
	}
	var stageErr *Error
	if errors.As(err, &stageErr) {
		return stageErr.Stage
	}
	return ""
}

// countingReader tracks the number of bytes read so the metadata record
// reflects the produced archive size.
type countingReader struct {
	src io.Reader
	N   int64
}

func newCountingReader(src io.Reader) *countingReader {
	return &countingReader{src: src}
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.src.Read(p)
	c.N += int64(n)
	return n, err
}
