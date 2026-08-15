package runtime

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	dbmodels "github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/proxy"
	"github.com/cartethyia/daemon/internal/proxy/transport"
)

const (
	networkSnapshotTTL      = 2 * time.Second
	proxyFailureCollapse    = 2 * time.Second
	proxyFailureThreshold   = 3
	proxyBaseQuarantine     = 30 * time.Second
	proxyMaxQuarantine      = 15 * time.Minute
	proxyRecoveryProbeLease = 30 * time.Second
	maxProxyCollapseEntries = 1024
	maxProxyProbeEntries    = 1024
)

type durableProxyCoordinator struct {
	repository dbrepositories.ProxyRepository
	selector   *proxy.DefaultNetworkSelector
	now        func() time.Time
	evidence   *observability.Registry

	mu        sync.Mutex
	refreshMu sync.Mutex
	expires   time.Time
	settings  dbmodels.ProxySettings
	routes    []proxy.ProxyEndpoint
	health    map[string]durableProxyHealth
	collapse  map[string]time.Time
	probes    map[string]time.Time
}

type durableProxyHealth struct {
	enabled      bool
	healthy      bool
	status       string
	retryAt      *time.Time
	probeUntil   *time.Time
	failureCount int
}

func newDurableProxyCoordinator(repository dbrepositories.ProxyRepository, evidence *observability.Registry) *durableProxyCoordinator {
	if repository == nil {
		return nil
	}
	return &durableProxyCoordinator{
		repository: repository,
		selector:   proxy.NewDefaultNetworkSelector(),
		now:        time.Now,
		evidence:   evidence,
		health:     make(map[string]durableProxyHealth),
		collapse:   make(map[string]time.Time),
		probes:     make(map[string]time.Time),
	}
}

func (s *durableProxyCoordinator) selectProxy(ctx context.Context, providerID, _ string) (transport.ProxySelection, error) {
	if err := s.refresh(ctx); err != nil {
		return transport.ProxySelection{}, err
	}
	now := s.now().UTC()
	s.mu.Lock()
	settings := s.settings
	routes := append([]proxy.ProxyEndpoint(nil), s.routes...)
	health := make(map[string]durableProxyHealth, len(s.health))
	for id, value := range s.health {
		health[id] = value
	}
	s.mu.Unlock()

	for _, excluded := range settings.ExcludedProviders {
		if strings.EqualFold(strings.TrimSpace(excluded), providerID) {
			return transport.ProxySelection{Release: func() {}}, nil
		}
	}
	mode := proxy.NetworkModeDirect
	if settings.Enabled {
		mode = proxy.NetworkModeProxy
		if settings.SmartDynamicRouting {
			mode = proxy.NetworkModeAuto
		}
	}
	var probeIDs map[string]bool
	for _, route := range routes {
		if mode == proxy.NetworkModeDirect {
			break
		}
		value := health[route.ID]
		if value.healthy || value.retryAt == nil || now.Before(*value.retryAt) {
			continue
		}
		claimed, err := s.claimProbe(ctx, route.ID, now)
		if err != nil {
			continue
		}
		if claimed {
			if probeIDs == nil {
				probeIDs = make(map[string]bool)
			}
			value.healthy = true
			value.status = "probing"
			probeUntil := now.Add(proxyRecoveryProbeLease)
			value.probeUntil = &probeUntil
			health[route.ID] = value
			probeIDs[route.ID] = true
		}
	}
	eligible := make([]proxy.ProxyEndpoint, 0, len(routes))
	for _, route := range routes {
		if value := health[route.ID]; value.enabled && value.healthy {
			eligible = append(eligible, route)
		}
	}
	selectionRoutes := eligible
	if len(selectionRoutes) == 0 {
		selectionRoutes = routes
	}
	selection, err := s.selector.Select(ctx, proxy.SelectNetworkInput{
		ProviderID: providerID,
		Mode:       mode,
		Proxies:    selectionRoutes,
		Health:     durableProxyHealthLookup{values: health},
	})
	if err != nil || !selection.UseProxy {
		return transport.ProxySelection{Release: selection.Release}, err
	}
	for _, route := range selectionRoutes {
		if route.ID != selection.ProxyID {
			continue
		}
		u, parseErr := url.Parse(route.URL)
		if parseErr != nil {
			selection.Release()
			return transport.ProxySelection{}, parseErr
		}
		value := health[selection.ProxyID]
		return transport.ProxySelection{
			URL:           u,
			ID:            selection.ProxyID,
			Probe:         probeIDs[selection.ProxyID],
			ReportSuccess: value.failureCount > 0 || probeIDs[selection.ProxyID],
			Release:       selection.Release,
		}, nil
	}
	selection.Release()
	return transport.ProxySelection{}, errors.New("runtime: selected proxy route disappeared")
}

func (s *durableProxyCoordinator) refresh(ctx context.Context) error {
	now := s.now().UTC()
	s.mu.Lock()
	if now.Before(s.expires) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	now = s.now().UTC()
	s.mu.Lock()
	if now.Before(s.expires) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	settings, err := s.repository.GetSettings(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	proxies, err := s.repository.List(ctx)
	if err != nil {
		return err
	}
	routes := make([]proxy.ProxyEndpoint, 0, len(proxies))
	health := make(map[string]durableProxyHealth, len(proxies))
	for _, item := range proxies {
		if item.ID == "" || item.Host == "" || item.Port <= 0 || !item.Active {
			continue
		}
		protocol := strings.ToLower(string(item.Protocol))
		if protocol != "http" && protocol != "https" && protocol != "socks5" {
			continue
		}
		u := &url.URL{Scheme: protocol, Host: item.Host}
		u.Host = u.Host + ":" + formatPort(item.Port)
		if item.Username != "" {
			u.User = url.UserPassword(item.Username, item.Password)
		}
		routes = append(routes, proxy.ProxyEndpoint{ID: item.ID, URL: u.String(), Enabled: item.Active, MaxConcurrency: item.MaxConcurrency})
		s.selector.SetCapacity(item.ID, item.MaxConcurrency)
		value := durableProxyHealth{enabled: item.Active, healthy: item.CooldownUntil == nil || !now.Before(*item.CooldownUntil), status: "healthy", retryAt: item.CooldownUntil}
		if persisted, healthErr := s.repository.GetHealth(ctx, item.ID); healthErr == nil {
			value = durableProxyHealth{
				enabled:      item.Active,
				healthy:      persisted.Status == "healthy" || persisted.Status == "",
				status:       persisted.Status,
				retryAt:      persisted.RetryAt,
				probeUntil:   persisted.ProbeUntil,
				failureCount: persisted.FailureCount,
			}
		} else if !errors.Is(healthErr, sql.ErrNoRows) {
			return healthErr
		}
		health[item.ID] = value
	}
	s.mu.Lock()
	s.settings = settings
	s.routes = routes
	s.health = health
	s.expires = now.Add(networkSnapshotTTL)
	s.evictExpiredLocked(s.collapse, now, maxProxyCollapseEntries)
	s.evictExpiredLocked(s.probes, now, maxProxyProbeEntries)
	s.mu.Unlock()
	return nil
}

func (s *durableProxyCoordinator) recordFailure(ctx context.Context, proxyID, kind, message string) {
	if s == nil || proxyID == "" || ctx == nil || ctx.Err() != nil {
		return
	}
	now := s.now().UTC()
	s.mu.Lock()
	s.evictExpiredLocked(s.collapse, now, maxProxyCollapseEntries)
	if until, exists := s.collapse[proxyID]; exists && now.Before(until) {
		s.mu.Unlock()
		return
	}
	s.makeRoomLocked(s.collapse, maxProxyCollapseEntries)
	s.collapse[proxyID] = now.Add(proxyFailureCollapse)
	s.mu.Unlock()

	s.mu.Lock()
	previousStatus := s.health[proxyID].status
	s.mu.Unlock()
	persisted, err := s.repository.RecordHealthFailure(ctx, proxyID, kind, message, now, proxyFailureCollapse, proxyFailureThreshold, proxyBaseQuarantine, proxyMaxQuarantine)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.health[proxyID] = durableProxyHealth{
		enabled:      true,
		healthy:      persisted.Status == "healthy" || persisted.Status == "",
		status:       persisted.Status,
		retryAt:      persisted.RetryAt,
		probeUntil:   persisted.ProbeUntil,
		failureCount: persisted.FailureCount,
	}
	delete(s.probes, proxyID)
	s.expires = time.Time{}
	s.mu.Unlock()
	if s.evidence != nil && previousStatus != "cooling_down" && persisted.Status == "cooling_down" {
		s.evidence.ObserveProxyQuarantine()
	}
}

func (s *durableProxyCoordinator) recordSuccess(ctx context.Context, proxyID string) {
	if s == nil || proxyID == "" || ctx == nil || ctx.Err() != nil {
		return
	}
	now := s.now().UTC()
	if err := s.repository.RecordHealthSuccess(ctx, proxyID, now); err != nil {
		return
	}
	s.mu.Lock()
	value := s.health[proxyID]
	value.healthy = true
	value.status = "healthy"
	value.retryAt = nil
	value.probeUntil = nil
	value.failureCount = 0
	s.health[proxyID] = value
	delete(s.probes, proxyID)
	s.expires = time.Time{}
	s.mu.Unlock()
}

func (s *durableProxyCoordinator) claimProbe(ctx context.Context, proxyID string, now time.Time) (bool, error) {
	s.mu.Lock()
	s.evictExpiredLocked(s.probes, now, maxProxyProbeEntries)
	if until, exists := s.probes[proxyID]; exists && now.Before(until) {
		s.mu.Unlock()
		return false, nil
	}
	s.mu.Unlock()
	leaseUntil := now.Add(proxyRecoveryProbeLease)
	claimed, err := s.repository.ClaimHealthProbe(ctx, proxyID, now, leaseUntil)
	if err != nil || !claimed {
		return claimed, err
	}
	s.mu.Lock()
	s.makeRoomLocked(s.probes, maxProxyProbeEntries)
	s.probes[proxyID] = leaseUntil
	if value, ok := s.health[proxyID]; ok {
		value.status = "probing"
		value.probeUntil = &leaseUntil
		s.health[proxyID] = value
	}
	s.mu.Unlock()
	return true, nil
}

func (s *durableProxyCoordinator) evictExpiredLocked(entries map[string]time.Time, now time.Time, limit int) {
	for id, until := range entries {
		if !now.Before(until) {
			delete(entries, id)
		}
	}
	for len(entries) > limit {
		s.evictOldestLocked(entries)
	}
}

func (s *durableProxyCoordinator) makeRoomLocked(entries map[string]time.Time, limit int) {
	for len(entries) >= limit {
		s.evictOldestLocked(entries)
	}
}

func (s *durableProxyCoordinator) evictOldestLocked(entries map[string]time.Time) {
	var oldestID string
	var oldest time.Time
	for id, until := range entries {
		if oldestID == "" || until.Before(oldest) {
			oldestID = id
			oldest = until
		}
	}
	if oldestID != "" {
		delete(entries, oldestID)
	}
}

func formatPort(port int) string {
	if port < 0 {
		return "0"
	}
	return strconv.Itoa(port)
}

type durableProxyHealthLookup struct {
	values map[string]durableProxyHealth
}

func (h durableProxyHealthLookup) IsHealthy(proxyID string, _ time.Time) bool {
	value, ok := h.values[proxyID]
	return ok && value.enabled && value.healthy
}

func (h durableProxyHealthLookup) IsEnabled(proxyID string) bool {
	value, ok := h.values[proxyID]
	return ok && value.enabled
}
