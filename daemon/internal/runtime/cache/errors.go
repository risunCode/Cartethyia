package cache

import (
	"errors"
	"fmt"
)

// ErrClosed is returned by Get/Set/Delete after Close has been called.
var ErrClosed = errors.New("cache: backend is closed")

// ErrInvalidKey is returned when a Key is missing required components (empty
// model or surface) or carries an empty Version.
var ErrInvalidKey = errors.New("cache: invalid key")

// ErrInvalidTTL is returned when Set is called with a non-positive TTL.
var ErrInvalidTTL = errors.New("cache: ttl must be positive")

// ErrCapacityExhausted is returned when the cache cannot accept a write because
// the configured capacity is non-zero and the backend cannot evict further
// entries. The memory backend should never trigger this in practice because
// LRU eviction always succeeds, but the sentinel exists for future Redis or
// quota-bound backends.
var ErrCapacityExhausted = errors.New("cache: capacity exhausted")

// ErrRouterConfig identifies an invalid cache-router construction.
var ErrRouterConfig = errors.New("cache: router configuration error")

// ErrRemoteNotConfigured identifies a missing optional remote backend.
var ErrRemoteNotConfigured = errors.New("cache: remote backend is not configured")

// ErrRemoteCommand identifies a remote command failure.
var ErrRemoteCommand = errors.New("cache: remote command failed")

// ErrRemoteProbe identifies a failed remote health probe.
var ErrRemoteProbe = errors.New("cache: remote probe failed")

// ErrRemoteTimeout identifies a timeout imposed by the remote backend.
var ErrRemoteTimeout = errors.New("cache: remote command timeout")

// ErrRemoteSerialization identifies an invalid or unrepresentable remote
// cache record. Such records must never be treated as a cache hit.
var ErrRemoteSerialization = errors.New("cache: remote serialization failed")

// ErrFallback identifies a failure in the configured memory fallback.
var ErrFallback = errors.New("cache: fallback backend failed")

// ErrCoordinationUnavailable identifies a coordination-critical operation
// attempted while the distributed backend is not online. Local memory is
// deliberately not treated as an equivalent distributed lock/store.
var ErrCoordinationUnavailable = errors.New("cache: coordination backend unavailable")

// BackendError attaches a stable cache-prefixed class to an underlying cause.
// Is preserves both the class sentinel and errors.Is matching on the cause.
type BackendError struct {
	Code error
	Op   string
	Err  error
}

func (e *BackendError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Op == "" {
		if e.Err == nil {
			return e.Code.Error()
		}
		return e.Code.Error() + ": " + e.Err.Error()
	}
	if e.Err == nil {
		return e.Code.Error() + ": " + e.Op
	}
	return e.Code.Error() + ": " + e.Op + ": " + e.Err.Error()
}

func (e *BackendError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *BackendError) Is(target error) bool {
	if e == nil {
		return target == nil
	}
	return target == e.Code || errors.Is(e.Err, target)
}

func cacheError(code error, op string, err error) error {
	if err == nil {
		return &BackendError{Code: code, Op: op}
	}
	if existing, ok := err.(*BackendError); ok && existing.Code == code {
		return err
	}
	return &BackendError{Code: code, Op: op, Err: err}
}

// GenerationMismatchError is returned by Get when the cached entry was
// recorded against a different catalog/credential/network/generation tuple
// than the supplied key requests. Callers MUST treat the result as a miss.
type GenerationMismatchError struct {
	Key       Key
	Stored    Generation
	Requested Generation
}

func (e *GenerationMismatchError) Error() string {
	return fmt.Sprintf(
		"cache: generation mismatch for key %q (stored=%s requested=%s)",
		e.Key.Wire(), e.Stored, e.Requested,
	)
}

// Is reports whether target is ErrClosed so callers can use errors.Is
// uniformly against the typed sentinel.
func (e *GenerationMismatchError) Is(target error) bool {
	return target == ErrGenerationMismatch
}

// ErrGenerationMismatch is the sentinel used by errors.Is to detect any
// GenerationMismatchError. The concrete error always carries the detailed
// GenerationMismatchError so logs can surface stored vs requested generations.
var ErrGenerationMismatch = errors.New("cache: generation mismatch")

// MissError indicates that Get could not return an entry. It distinguishes
// "not present" from generation mismatch and other failures.
type MissError struct {
	Key Key
	// Reason describes why the entry is not usable. Empty means the key was
	// simply absent.
	Reason string
}

func (e *MissError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("cache: miss for key %q", e.Key.Wire())
	}
	return fmt.Sprintf("cache: miss for key %q: %s", e.Key.Wire(), e.Reason)
}

// Is reports whether target is the missing-sentinel so handlers can use
// errors.Is(err, cache.ErrMiss) regardless of reason text.
func (e *MissError) Is(target error) bool {
	return target == ErrMiss
}

// ErrMiss is the sentinel returned when an entry is not present in the cache.
// Use errors.Is(err, cache.ErrMiss) to detect a miss without inspecting the
// concrete type.
var ErrMiss = errors.New("cache: miss")
