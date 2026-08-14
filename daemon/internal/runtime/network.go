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
	"github.com/cartethyia/daemon/internal/proxy"
	"github.com/cartethyia/daemon/internal/proxy/transport"
)

const networkSnapshotTTL = 2 * time.Second

type durableNetworkSelector struct {
	repository dbrepositories.ProxyRepository
	selector   *proxy.DefaultNetworkSelector

	mu        sync.Mutex
	refreshMu sync.Mutex
	expires   time.Time
	settings  dbmodels.ProxySettings
	routes    []proxy.ProxyEndpoint
	health    map[string]durableProxyHealth
}

type durableProxyHealth struct {
	enabled bool
	healthy bool
	retryAt *time.Time
}

func newDurableNetworkSelector(repository dbrepositories.ProxyRepository) transport.ProxySelector {
	if repository == nil {
		return nil
	}
	selector := &durableNetworkSelector{
		repository: repository,
		selector:   proxy.NewDefaultNetworkSelector(),
		health:     make(map[string]durableProxyHealth),
	}
	return selector.selectProxy
}

func (s *durableNetworkSelector) selectProxy(ctx context.Context, providerID, _ string) (transport.ProxySelection, error) {
	if err := s.refresh(ctx); err != nil {
		return transport.ProxySelection{}, err
	}
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
	selection, err := s.selector.Select(ctx, proxy.SelectNetworkInput{
		ProviderID: providerID,
		Mode:       mode,
		Proxies:    routes,
		Health:     durableProxyHealthLookup{values: health},
	})
	if err != nil || !selection.UseProxy {
		return transport.ProxySelection{Release: selection.Release}, err
	}
	for _, route := range routes {
		if route.ID != selection.ProxyID {
			continue
		}
		u, parseErr := url.Parse(route.URL)
		if parseErr != nil {
			selection.Release()
			return transport.ProxySelection{}, parseErr
		}
		return transport.ProxySelection{URL: u, ID: selection.ProxyID, Release: selection.Release}, nil
	}
	selection.Release()
	return transport.ProxySelection{}, errors.New("runtime: selected proxy route disappeared")
}

func (s *durableNetworkSelector) refresh(ctx context.Context) error {
	now := time.Now()
	s.mu.Lock()
	if now.Before(s.expires) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	now = time.Now()
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
		if item.Port > 0 {
			u.Host = u.Host + ":" + formatPort(item.Port)
		}
		if item.Username != "" {
			u.User = url.UserPassword(item.Username, item.Password)
		}
		routes = append(routes, proxy.ProxyEndpoint{ID: item.ID, URL: u.String(), Enabled: item.Active, MaxConcurrency: item.MaxConcurrency})
		s.selector.SetCapacity(item.ID, item.MaxConcurrency)
		health[item.ID] = durableProxyHealth{enabled: item.Active, healthy: true, retryAt: item.CooldownUntil}
		if value, healthErr := s.repository.GetHealth(ctx, item.ID); healthErr == nil {
			health[item.ID] = durableProxyHealth{enabled: item.Active, healthy: value.Status == "healthy" || value.Status == "", retryAt: value.RetryAt}
		}
	}
	s.mu.Lock()
	s.settings = settings
	s.routes = routes
	s.health = health
	s.expires = now.Add(networkSnapshotTTL)
	s.mu.Unlock()
	return nil
}

func newDurableProxyFailureRecorder(repository dbrepositories.ProxyRepository) transport.ProxyFailureRecorder {
	if repository == nil {
		return nil
	}
	return func(ctx context.Context, proxyID, kind, message string) {
		retryAt := time.Now().UTC().Add(30 * time.Second)
		_ = repository.UpsertHealth(ctx, dbmodels.ProxyHealth{
			ProxyID:          proxyID,
			Status:           "cooling_down",
			ErrorKind:        kind,
			SanitizedMessage: message,
			OccurredAt:       timePtr(time.Now().UTC()),
			RetryAt:          &retryAt,
		})
	}
}

func timePtr(value time.Time) *time.Time { return &value }

func formatPort(port int) string {
	if port < 0 {
		return "0"
	}
	return strconv.Itoa(port)
}

type durableProxyHealthLookup struct {
	values map[string]durableProxyHealth
}

func (h durableProxyHealthLookup) IsHealthy(proxyID string, now time.Time) bool {
	value, ok := h.values[proxyID]
	if !ok || !value.enabled || !value.healthy {
		return false
	}
	return value.retryAt == nil || now.After(*value.retryAt)
}

func (h durableProxyHealthLookup) IsEnabled(proxyID string) bool {
	value, ok := h.values[proxyID]
	return ok && value.enabled
}

var _ transport.ProxySelector = (transport.ProxySelector)(nil)
