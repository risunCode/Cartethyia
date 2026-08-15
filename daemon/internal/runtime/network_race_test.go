package runtime

import (
	"context"
	"sync"
	"testing"
	"time"

	dbmodels "github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
)

type proxyCoordinatorRaceRepository struct {
	dbrepositories.ProxyRepository
	mu           sync.Mutex
	settings     dbmodels.ProxySettings
	proxies      []dbmodels.Proxy
	health       dbmodels.ProxyHealth
	probeClaimed bool
	probeClaims  int
	failureCalls int
}

func (r *proxyCoordinatorRaceRepository) GetSettings(context.Context) (dbmodels.ProxySettings, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	settings := r.settings
	settings.ExcludedProviders = append([]string(nil), settings.ExcludedProviders...)
	return settings, nil
}

func (r *proxyCoordinatorRaceRepository) List(context.Context) ([]dbmodels.Proxy, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]dbmodels.Proxy(nil), r.proxies...), nil
}

func (r *proxyCoordinatorRaceRepository) GetHealth(context.Context, string) (dbmodels.ProxyHealth, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.health, nil
}

func (r *proxyCoordinatorRaceRepository) ClaimHealthProbe(_ context.Context, _ string, _, leaseUntil time.Time) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.probeClaimed {
		return false, nil
	}
	r.probeClaimed = true
	r.probeClaims++
	r.health.Status = "probing"
	r.health.ProbeUntil = &leaseUntil
	return true, nil
}

func (r *proxyCoordinatorRaceRepository) RecordHealthFailure(_ context.Context, proxyID, kind, _ string, occurredAt time.Time, _ time.Duration, _ int, _, _ time.Duration) (dbmodels.ProxyHealth, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failureCalls++
	retryAt := occurredAt.Add(time.Minute)
	r.health = dbmodels.ProxyHealth{ProxyID: proxyID, Status: "unhealthy", ErrorKind: kind, RetryAt: &retryAt, FailureCount: r.health.FailureCount + 1, UpdatedAt: occurredAt}
	return r.health, nil
}

func TestDurableProxyCoordinatorConcurrentProbeAndFailureCollapse(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	retryAt := now.Add(-time.Second)
	repository := &proxyCoordinatorRaceRepository{
		settings: dbmodels.ProxySettings{Enabled: true, SmartDynamicRouting: true},
		proxies:  []dbmodels.Proxy{{ID: "proxy-1", Protocol: dbmodels.ProxyProtocolHTTP, Host: "127.0.0.1", Port: 8080, MaxConcurrency: 128, Active: true}},
		health:   dbmodels.ProxyHealth{ProxyID: "proxy-1", Status: "unhealthy", RetryAt: &retryAt, FailureCount: 3},
	}
	coordinator := newDurableProxyCoordinator(repository, nil)
	coordinator.now = func() time.Time { return now }

	const goroutines = 128
	start := make(chan struct{})
	selections := make(chan bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for range goroutines {
		go func() {
			defer wg.Done()
			<-start
			selection, err := coordinator.selectProxy(context.Background(), "openai", "model")
			if err != nil {
				t.Errorf("select proxy: %v", err)
				return
			}
			selections <- selection.Probe
			if selection.Release != nil {
				selection.Release()
			}
		}()
	}
	close(start)
	wg.Wait()
	close(selections)
	probeSelections := 0
	for probe := range selections {
		if probe {
			probeSelections++
		}
	}
	repository.mu.Lock()
	probeClaims := repository.probeClaims
	repository.mu.Unlock()
	if probeClaims != 1 || probeSelections != 1 {
		t.Fatalf("durable/local probe claims=%d/%d, want exactly one", probeClaims, probeSelections)
	}

	start = make(chan struct{})
	wg.Add(goroutines)
	for range goroutines {
		go func() {
			defer wg.Done()
			<-start
			coordinator.recordFailure(context.Background(), "proxy-1", "connect", "sanitized")
		}()
	}
	close(start)
	wg.Wait()
	repository.mu.Lock()
	failureCalls := repository.failureCalls
	repository.mu.Unlock()
	if failureCalls != 1 {
		t.Fatalf("collapsed durable failure writes=%d, want one", failureCalls)
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if len(coordinator.collapse) != 1 || len(coordinator.probes) > 1 {
		t.Fatalf("coordinator map bounds collapse=%d probes=%d", len(coordinator.collapse), len(coordinator.probes))
	}
}
