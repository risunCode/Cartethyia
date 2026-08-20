package telemetry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ErrorCode is the stable machine-readable class of a capture failure.
type ErrorCode string

const (
	CodeDisabled       ErrorCode = "capture.disabled"
	CodeLimit          ErrorCode = "capture.limit"
	CodeSensitive      ErrorCode = "capture.sensitive"
	CodeRedaction      ErrorCode = "capture.redaction"
	CodeCancelled      ErrorCode = "capture.cancelled"
	CodeAudit          ErrorCode = "capture.audit"
	CodeInvalidConfig  ErrorCode = "capture.invalid_config"
	CodeProviderOptOut ErrorCode = "capture.provider_opt_out"
	CodeOutOfScope     ErrorCode = "capture.out_of_scope"
)

// captureError is a package-owned, machine-readable capture failure.
type captureError struct {
	Code ErrorCode
	Err  error
}

func (e *captureError) Error() string {
	if e.Err == nil {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Err.Error()
}
func (e *captureError) Unwrap() error { return e.Err }
func (e *captureError) Is(target error) bool {
	if e == target {
		return true
	}
	// ErrSensitive predates the more precise redaction code. Keep errors.Is
	// compatibility while reporting capture.redaction through CodeOf.
	return target == ErrSensitive && e.Code == CodeRedaction
}

var (
	ErrDisabled       = &captureError{Code: CodeDisabled, Err: errors.New("capture disabled")}
	ErrLimit          = &captureError{Code: CodeLimit, Err: errors.New("capture limit exceeded")}
	ErrSensitive      = &captureError{Code: CodeSensitive, Err: errors.New("sensitive payload rejected")}
	ErrRedaction      = &captureError{Code: CodeRedaction, Err: errors.New("payload redaction failed")}
	ErrCancelled      = &captureError{Code: CodeCancelled, Err: context.Canceled}
	ErrAudit          = &captureError{Code: CodeAudit, Err: errors.New("capture audit failed")}
	ErrInvalidConfig  = &captureError{Code: CodeInvalidConfig, Err: errors.New("invalid capture configuration")}
	ErrProviderOptOut = &captureError{Code: CodeProviderOptOut, Err: errors.New("provider opted out of capture")}
	ErrOutOfScope     = &captureError{Code: CodeOutOfScope, Err: errors.New("capture is outside configured scope")}
)

// CodeOf returns the stable package-owned code for an error.
func CodeOf(err error) ErrorCode {
	if err == nil {
		return ""
	}
	var coded *captureError
	if errors.As(err, &coded) {
		return coded.Code
	}
	return ""
}

const (
	DefaultMaxBytes   = 1 << 20
	DefaultMaxRecords = 100
	DefaultRetention  = time.Hour
	HardMaxBytes      = 16 << 20
	HardMaxRecords    = 10_000
	HardMaxTotalBytes = 64 << 20
	MaxRetention      = 30 * 24 * time.Hour
)

// Scope limits capture to explicit request IDs and/or providers. An empty
// dimension means "any value" for that dimension; Enabled is still required.
type Scope struct {
	RequestIDs map[string]struct{}
	Providers  map[string]struct{}
}

func (s Scope) allows(requestID, provider string) bool {
	if len(s.RequestIDs) > 0 {
		if _, ok := s.RequestIDs[requestID]; !ok {
			return false
		}
	}
	if len(s.Providers) > 0 {
		if _, ok := s.Providers[strings.ToLower(provider)]; ok {
			return true
		}
		if _, ok := s.Providers[provider]; !ok {
			return false
		}
	}
	return true
}

// Config controls opt-in, bounded capture. Capture is disabled unless
// Enabled is true. ProviderOptOut and OptOutProviders are both accepted for
// compatibility with callers that use either spelling.
type Config struct {
	Enabled                  bool
	MaxBytes                 int
	MaxRecords               int
	MaxRequests              int
	MaxTotalBytes            int
	Retention                time.Duration
	RejectOnRedactionFailure bool // retained for API compatibility; redaction always fails closed
	Scope                    Scope
	ProviderOptOut           map[string]bool
	OptOutProviders          map[string]bool
	SecretPatterns           []string
	AuditSink                func(AuditEvent) error
}

// CaptureMetadata describes why and how a sensitive record was stored. It
// deliberately contains no body, secret, header, or credential material.
type CaptureMetadata struct {
	Sensitive     bool
	Redacted      bool
	Truncated     bool
	OriginalBytes int
	CapturedBytes int
}

type Record struct {
	ID         string
	RequestID  string
	Provider   string
	Body       []byte
	CapturedAt time.Time
	ExpiresAt  time.Time
	Metadata   CaptureMetadata
}

type AuditAction string

const (
	AuditStored   AuditAction = "capture.stored"
	AuditRejected AuditAction = "capture.rejected"
	AuditDeleted  AuditAction = "capture.deleted"
	AuditSkipped  AuditAction = "capture.skipped"
)

// AuditEvent is bounded metadata only. Raw payloads and secrets have no field
// in this type and therefore cannot be persisted by an audit sink.
type AuditEvent struct {
	Action     AuditAction
	RecordID   string
	RequestID  string
	Provider   string
	Code       ErrorCode
	Count      int
	Sensitive  bool
	OccurredAt time.Time
}

type Store struct {
	mu         sync.Mutex
	cfg        Config
	records    []Record
	totalBytes int
	patterns   []*regexp.Regexp
	audits     []AuditEvent
}

var defaultSecretPatterns = []string{
	`(?i)(["']?(?:api[_-]?key|authorization|x-api-key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|cookie|credential)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"',}\s]+`,
	`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`,
	`(?i)\b(?:sk|pk|rk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}`,
	`(?i)\bAKIA[0-9A-Z]{16}\b`,
}

func normalizeConfig(cfg Config) Config {
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultMaxBytes
	}
	if cfg.MaxBytes > HardMaxBytes {
		cfg.MaxBytes = HardMaxBytes
	}
	if cfg.MaxRecords <= 0 {
		cfg.MaxRecords = DefaultMaxRecords
	}
	if cfg.MaxRequests <= 0 {
		cfg.MaxRequests = cfg.MaxRecords
	}
	if cfg.MaxRecords > HardMaxRecords {
		cfg.MaxRecords = HardMaxRecords
	}
	if cfg.MaxRequests > HardMaxRecords {
		cfg.MaxRequests = HardMaxRecords
	}
	if cfg.MaxTotalBytes <= 0 {
		cfg.MaxTotalBytes = cfg.MaxBytes * cfg.MaxRequests
		if cfg.MaxTotalBytes < cfg.MaxBytes || cfg.MaxTotalBytes > HardMaxTotalBytes {
			cfg.MaxTotalBytes = HardMaxTotalBytes
		}
	}
	if cfg.MaxTotalBytes > HardMaxTotalBytes {
		cfg.MaxTotalBytes = HardMaxTotalBytes
	}
	if cfg.Retention <= 0 {
		cfg.Retention = DefaultRetention
	}
	if cfg.Retention > MaxRetention {
		cfg.Retention = MaxRetention
	}
	return cfg
}

// New constructs a store with safe bounded defaults. NewWithError is available
// when custom secret patterns must be validated explicitly.
func New(cfg Config) *Store {
	s, err := NewWithError(cfg)
	if err == nil {
		return s
	}
	// Built-in patterns are valid. This fallback is only reachable if a caller
	// supplied an invalid custom pattern; failing closed means no record can be
	// written rather than retaining the unredacted body.
	cfg.SecretPatterns = []string{"(?!)"}
	s, _ = NewWithError(cfg)
	return s
}

func NewWithError(cfg Config) (*Store, error) {
	cfg = normalizeConfig(cfg)
	patterns := cfg.SecretPatterns
	if len(patterns) == 0 {
		patterns = defaultSecretPatterns
	}
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, pattern := range patterns {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("%w: secret pattern: %v", ErrInvalidConfig, err)
		}
		compiled = append(compiled, re)
	}
	return &Store{cfg: cfg, patterns: compiled}, nil
}

func (s *Store) optedOut(provider string) bool {
	provider = strings.ToLower(provider)
	for _, set := range []map[string]bool{s.cfg.ProviderOptOut, s.cfg.OptOutProviders} {
		for name, disabled := range set {
			if disabled && strings.EqualFold(name, provider) {
				return true
			}
		}
	}
	return false
}

func (s *Store) notifyAudit(event AuditEvent) error {
	s.mu.Lock()
	sink := s.cfg.AuditSink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	if err := sink(event); err != nil {
		return fmt.Errorf("%w: %v", ErrAudit, err)
	}
	return nil
}

func (s *Store) emitAudit(event AuditEvent) {
	s.audits = append(s.audits, event)
}

func (s *Store) appendAudit(event AuditEvent) {
	s.mu.Lock()
	s.audits = append(s.audits, event)
	s.mu.Unlock()
}

// Capture stores one bounded request/response artifact. Disabled and
// out-of-scope/opted-out capture are documented optional absence and return
// nil without storing anything.
func (s *Store) Capture(id, requestID, provider string, body []byte, now time.Time) error {
	return s.CaptureContext(context.Background(), id, requestID, provider, body, now)
}

// CaptureContext is Capture with cancellation support. Cancellation is checked
// before redaction and before committing the record.
func (s *Store) CaptureContext(ctx context.Context, id, requestID, provider string, body []byte, now time.Time) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrCancelled, err)
	}
	s.mu.Lock()
	if !s.cfg.Enabled {
		s.mu.Unlock()
		return nil
	}
	if !s.cfg.Scope.allows(requestID, provider) || s.optedOut(provider) {
		s.mu.Unlock()
		return nil
	}
	maxBytes := s.cfg.MaxBytes
	patterns := append([]*regexp.Regexp(nil), s.patterns...)
	s.mu.Unlock()

	if len(body) > maxBytes {
		s.appendAudit(AuditEvent{Action: AuditRejected, RecordID: id, RequestID: requestID, Provider: provider, Code: CodeLimit, Sensitive: true, OccurredAt: now})
		return fmt.Errorf("%w: body_bytes=%d max_bytes=%d", ErrLimit, len(body), maxBytes)
	}
	redacted, ok := redactBody(body, patterns)
	if !ok {
		s.appendAudit(AuditEvent{Action: AuditRejected, RecordID: id, RequestID: requestID, Provider: provider, Code: CodeRedaction, Sensitive: true, OccurredAt: now})
		return ErrRedaction
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrCancelled, err)
	}

	event := AuditEvent{Action: AuditStored, RecordID: id, RequestID: requestID, Provider: provider, Sensitive: true, OccurredAt: now}
	if err := s.notifyAudit(event); err != nil {
		event.Action = AuditRejected
		event.Code = CodeAudit
		s.appendAudit(event)
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrCancelled, err)
	}
	if !s.cfg.Enabled || !s.cfg.Scope.allows(requestID, provider) || s.optedOut(provider) {
		return nil
	}
	if len(s.records) >= s.cfg.MaxRecords || len(s.records) >= s.cfg.MaxRequests {
		s.removeOldestLocked(1)
	}
	for s.totalBytes+len(redacted) > s.cfg.MaxTotalBytes && len(s.records) > 0 {
		s.removeOldestLocked(1)
	}
	if len(redacted) > s.cfg.MaxTotalBytes {
		s.emitAudit(AuditEvent{Action: AuditRejected, RecordID: id, RequestID: requestID, Provider: provider, Code: CodeLimit, Sensitive: true, OccurredAt: now})
		return fmt.Errorf("%w: body_bytes=%d total_bytes=%d", ErrLimit, len(redacted), s.cfg.MaxTotalBytes)
	}
	s.emitAudit(event)
	bodyCopy := append([]byte(nil), redacted...)
	s.records = append(s.records, Record{
		ID: id, RequestID: requestID, Provider: provider, Body: bodyCopy,
		CapturedAt: now, ExpiresAt: now.Add(s.cfg.Retention),
		Metadata: CaptureMetadata{Sensitive: true, Redacted: true, OriginalBytes: len(body), CapturedBytes: len(bodyCopy)},
	})
	s.totalBytes += len(bodyCopy)
	return nil
}

func (s *Store) removeOldestLocked(count int) {
	if count <= 0 || len(s.records) == 0 {
		return
	}
	if count > len(s.records) {
		count = len(s.records)
	}
	for _, record := range s.records[:count] {
		s.totalBytes -= len(record.Body)
	}
	s.records = append([]Record(nil), s.records[count:]...)
}

func (s *Store) List(now time.Time) []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteExpiredLocked(now)
	out := make([]Record, 0, len(s.records))
	for _, r := range s.records {
		r.Body = append([]byte(nil), r.Body...)
		out = append(out, r)
	}
	return out
}

func (s *Store) deleteExpiredLocked(now time.Time) int {
	removed := 0
	kept := s.records[:0]
	for _, r := range s.records {
		if !r.ExpiresAt.After(now) {
			s.totalBytes -= len(r.Body)
			removed++
			continue
		}
		kept = append(kept, r)
	}
	s.records = kept
	return removed
}

func (s *Store) DeleteExpired(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := s.deleteExpiredLocked(now)
	if removed > 0 {
		s.emitAudit(AuditEvent{Action: AuditDeleted, Count: removed, Sensitive: true, OccurredAt: now})
	}
	return removed
}

// DeleteExpiredContext supports cancellation for callers running retention.
func (s *Store) DeleteExpiredContext(ctx context.Context, now time.Time) (int, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrCancelled, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrCancelled, err)
	}
	removed := s.deleteExpiredLocked(now)
	if removed > 0 {
		s.emitAudit(AuditEvent{Action: AuditDeleted, Count: removed, Sensitive: true, OccurredAt: now})
	}
	return removed, nil
}

// RunRetention runs deletion on a bounded ticker until cancellation. Context
// cancellation is the normal worker shutdown path and returns nil.
func (s *Store) RunRetention(ctx context.Context, interval time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if interval <= 0 {
		s.mu.Lock()
		interval = s.cfg.Retention
		s.mu.Unlock()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-ticker.C:
			if _, err := s.DeleteExpiredContext(ctx, now); err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return nil
				}
				return err
			}
		}
	}
}

// AuditEvents returns a copy of bounded capture audit metadata.
func (s *Store) AuditEvents() []AuditEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]AuditEvent(nil), s.audits...)
}
func redactBody(body []byte, patterns []*regexp.Regexp) ([]byte, bool) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return nil, true
	}
	if !utf8.Valid(body) {
		return nil, false
	}
	text := string(body)
	for _, pattern := range patterns {
		text = pattern.ReplaceAllStringFunc(text, func(match string) string {
			if strings.Contains(match, "[REDACTED]") {
				return match
			}
			if index := strings.IndexAny(match, ":="); index >= 0 {
				return match[:index+1] + "[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	// Fail closed if a secret-like key/value or token survives every pattern.
	for _, pattern := range defaultSecretPatterns {
		for _, match := range regexp.MustCompile(pattern).FindAllString(text, -1) {
			if !strings.Contains(match, "[REDACTED]") {
				return nil, false
			}
		}
	}
	return []byte(text), true
}
