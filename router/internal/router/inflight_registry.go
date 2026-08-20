package router

import (
	"sync"
	"time"
)

// Bounded live-dispatch registry backing the admin in-flight stream.
//
// The registry mirrors admission leases: one record per accepted dispatch,
// removed when the buffered response completes or the stream finalizes. It is
// strictly bounded — the oldest tracked request is evicted at capacity — and
// every method is nil-safe so dispatch never depends on this observability
// surface.

const (
	defaultInFlightCapacity = 512
	minInFlightCapacity     = 16
	maxInFlightCapacity     = 4096
)

// BoundedInFlightRecord is one live dispatch as seen by the hot path.
type BoundedInFlightRecord struct {
	ID        string
	Model     string
	Surface   string
	StartedAt time.Time
}

type InFlightRegistry struct {
	mu      sync.Mutex
	records map[string]BoundedInFlightRecord
	order   []string
	cap     int
}

// NewInFlightRegistry builds a bounded registry; capacity is clamped to a
// sane range so a misconfigured value cannot allocate unbounded memory.
func NewInFlightRegistry(capacity int) *InFlightRegistry {
	if capacity < minInFlightCapacity {
		capacity = minInFlightCapacity
	}
	if capacity > maxInFlightCapacity {
		capacity = maxInFlightCapacity
	}
	return &InFlightRegistry{records: make(map[string]BoundedInFlightRecord, capacity), cap: capacity}
}

// Track registers a live dispatch. Records with an empty ID are ignored so
// anonymous dispatches never collide on a shared key.
func (r *InFlightRegistry) Track(record BoundedInFlightRecord) {
	if r == nil || record.ID == "" {
		return
	}
	if record.StartedAt.IsZero() {
		record.StartedAt = time.Now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.records[record.ID]; !exists {
		r.order = append(r.order, record.ID)
	}
	r.records[record.ID] = record
	for len(r.order) > r.cap {
		oldest := r.order[0]
		r.order = r.order[1:]
		delete(r.records, oldest)
	}
}

// Release removes a dispatch record; unknown IDs are ignored.
func (r *InFlightRegistry) Release(id string) {
	if r == nil || id == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.records[id]; !exists {
		return
	}
	delete(r.records, id)
	for index, candidate := range r.order {
		if candidate == id {
			r.order = append(r.order[:index], r.order[index+1:]...)
			break
		}
	}
}

// Snapshot returns the live dispatches in tracking order (oldest first).
func (r *InFlightRegistry) Snapshot() []BoundedInFlightRecord {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]BoundedInFlightRecord, 0, len(r.order))
	for _, id := range r.order {
		if record, ok := r.records[id]; ok {
			out = append(out, record)
		}
	}
	return out
}

// Len reports the number of live dispatches.
func (r *InFlightRegistry) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.records)
}
