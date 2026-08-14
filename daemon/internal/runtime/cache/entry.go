package cache

import "time"

// Entry is the value returned by Get. The stored Value is owned by the cache
// backend; callers MUST treat it as read-only. The Generation stored alongside
// the payload is what the cache layer uses to reject mismatched lookups.
type Entry struct {
	// Key is the lookup key the entry was recorded under. Callers can use
	// this to compare with their own Key for diagnostics.
	Key Key
	// Value is the cached payload. Memory always returns a defensive copy so
	// the caller cannot mutate stored state.
	Value []byte
	// StoredAt is the wall-clock instant the entry was written.
	StoredAt time.Time
	// ExpiresAt is the wall-clock instant after which the entry is invalid.
	ExpiresAt time.Time
	// Generation is the generation snapshot the entry was recorded under.
	Generation Generation
	// Remaining is the time-to-live remaining at the moment Get returned the
	// entry. Negative when the entry is already past ExpiresAt (callers
	// should treat that as a miss, but the value is exposed for diagnostics).
	Remaining time.Duration
}

// storedEntry is the internal form kept by the memory backend.
type storedEntry struct {
	key        string
	owner      Key
	payload    []byte
	storedAt   time.Time
	expiresAt  time.Time
	generation Generation
}
