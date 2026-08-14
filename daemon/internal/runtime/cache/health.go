package cache

import "time"

// HealthState describes whether the backend is currently serving traffic.
type HealthState string

const (
	// HealthOnline indicates the backend is responsive and serving traffic.
	HealthOnline HealthState = "online"
	// HealthOffline indicates the backend is not configured or has been
	// closed. The L0 memory backend reports HealthOffline after Close; the
	// R-CACHE-02 contract calls this the "Redis not configured" state.
	HealthOffline HealthState = "offline"
	// HealthUnhealthy indicates the backend is configured but a recent
	// probe or command failed. Callers should fall back to memory and let
	// the recovery worker retry with bounded backoff (R-CACHE-02).
	HealthUnhealthy HealthState = "unhealthy"
)

// Health is the snapshot returned by Cache.Health. It is concurrency-safe to
// read even while writers are active because all fields are plain values
// captured atomically when the snapshot is taken.
type Health struct {
	State HealthState
	// LastChecked is the instant the snapshot was captured.
	LastChecked time.Time
	// LastError is the most recent error observed while serving traffic, or
	// nil. Used to explain Unhealthy transitions to operators.
	LastError error
	// Entries is the current number of stored entries. May be zero in
	// degraded/offline states.
	Entries int
	// Capacity is the configured maximum number of entries. Zero means
	// unbounded.
	Capacity int
	// Hits / Misses are cumulative counters since the backend was opened.
	Hits   uint64
	Misses uint64
}

// IsUsable reports whether the backend is allowed to serve traffic for a
// fresh lookup. The memory backend is usable in HealthOnline; callers using a
// router must route around the backend when !IsUsable.
func (h Health) IsUsable() bool {
	return h.State == HealthOnline
}
