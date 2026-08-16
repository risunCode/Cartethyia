package proxy

import (
	"testing"
	"time"
)

func TestInFlightRegistryTrackReleaseSnapshot(t *testing.T) {
	registry := NewInFlightRegistry(64)
	started := time.Now().Add(-time.Second)
	registry.Track(BoundedInFlightRecord{ID: "a", Model: "m1", Surface: "openai", StartedAt: started})
	registry.Track(BoundedInFlightRecord{ID: "b", Model: "m2", Surface: "anthropic", StartedAt: started.Add(100 * time.Millisecond)})

	if got := registry.Len(); got != 2 {
		t.Fatalf("len: %d", got)
	}
	snapshot := registry.Snapshot()
	if len(snapshot) != 2 || snapshot[0].ID != "a" || snapshot[1].ID != "b" {
		t.Fatalf("snapshot order: %+v", snapshot)
	}

	registry.Release("a")
	if got := registry.Len(); got != 1 {
		t.Fatalf("len after release: %d", got)
	}
	registry.Release("missing")
	if got := registry.Len(); got != 1 {
		t.Fatalf("unknown release changed len: %d", got)
	}
}

func TestInFlightRegistryEvictsOldestAtCapacity(t *testing.T) {
	registry := NewInFlightRegistry(8) // clamped up to the minimum of 16
	for i := 0; i < 32; i++ {
		registry.Track(BoundedInFlightRecord{ID: string(rune('a'+i%26)) + time.Duration(i).String(), StartedAt: time.Now().Add(time.Duration(i) * time.Millisecond)})
	}
	if got := registry.Len(); got > minInFlightCapacity {
		t.Fatalf("capacity exceeded: %d", got)
	}
}

func TestInFlightRegistryNilSafety(t *testing.T) {
	var registry *InFlightRegistry
	registry.Track(BoundedInFlightRecord{ID: "a"})
	registry.Release("a")
	if got := registry.Len(); got != 0 {
		t.Fatalf("nil len: %d", got)
	}
	if snapshot := registry.Snapshot(); snapshot != nil {
		t.Fatalf("nil snapshot: %+v", snapshot)
	}
}

func TestInFlightRegistryEmptyIDIgnored(t *testing.T) {
	registry := NewInFlightRegistry(64)
	registry.Track(BoundedInFlightRecord{Model: "m"})
	if got := registry.Len(); got != 0 {
		t.Fatalf("empty id tracked: %d", got)
	}
}
