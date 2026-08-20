package egress

import (
	"context"
	"testing"
	"time"

	dbmodels "github.com/cartethyia/daemon/internal/storage/models"
)

type proxyHealthStubRepository struct {
	proxyCoordinatorRaceRepository
	successCalls int
}

func (r *proxyHealthStubRepository) RecordHealthSuccess(_ context.Context, proxyID string, _ time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.successCalls++
	r.health = dbmodels.ProxyHealth{ProxyID: proxyID, Status: "healthy"}
	return nil
}

func TestDurableProxyCoordinatorRecordSuccess(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	repository := &proxyHealthStubRepository{
		proxyCoordinatorRaceRepository: proxyCoordinatorRaceRepository{
			settings: dbmodels.ProxySettings{Enabled: true},
			proxies:  []dbmodels.Proxy{{ID: "proxy-1", Protocol: dbmodels.ProxyProtocolHTTP, Host: "127.0.0.1", Port: 8080, MaxConcurrency: 128, Active: true}},
			health:   dbmodels.ProxyHealth{ProxyID: "proxy-1", Status: "unhealthy", FailureCount: 2},
		},
	}
	coordinator := NewDurableProxyCoordinator(repository, nil)
	coordinator.now = func() time.Time { return now }

	coordinator.RecordSuccess(context.Background(), "proxy-1")
	if repository.successCalls != 1 {
		t.Fatalf("successCalls = %d, want 1", repository.successCalls)
	}
	coordinator.mu.Lock()
	health := coordinator.health["proxy-1"]
	coordinator.mu.Unlock()
	if !health.healthy || health.status != "healthy" {
		t.Fatalf("health after success = %#v", health)
	}
}

func TestDurableProxyCoordinatorEvictsOldestProbeEntries(t *testing.T) {
	repository := &proxyCoordinatorRaceRepository{
		settings: dbmodels.ProxySettings{Enabled: true},
		proxies:  []dbmodels.Proxy{{ID: "proxy-1", Protocol: dbmodels.ProxyProtocolHTTP, Host: "127.0.0.1", Port: 8080, MaxConcurrency: 128, Active: true}},
	}
	coordinator := NewDurableProxyCoordinator(repository, nil)
	now := time.Unix(1_700_000_000, 0).UTC()
	coordinator.now = func() time.Time { return now }

	for i := range maxProxyProbeEntries + 2 {
		id := "proxy-extra-" + string(rune('a'+i))
		coordinator.mu.Lock()
		coordinator.makeRoomLocked(coordinator.probes, maxProxyProbeEntries)
		coordinator.probes[id] = now.Add(time.Duration(i+1) * time.Second)
		coordinator.mu.Unlock()
	}
	coordinator.mu.Lock()
	count := len(coordinator.probes)
	coordinator.mu.Unlock()
	if count > maxProxyProbeEntries {
		t.Fatalf("probe entries = %d, want <= %d", count, maxProxyProbeEntries)
	}
}

func TestFormatPortNegative(t *testing.T) {
	if got := formatPort(-1); got != "0" {
		t.Fatalf("formatPort(-1) = %q, want 0", got)
	}
	if got := formatPort(8080); got != "8080" {
		t.Fatalf("formatPort(8080) = %q", got)
	}
}
