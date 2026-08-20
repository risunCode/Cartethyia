// File: selectors.go
// Provider / credential / network selection primitives. Each selector is a
// narrow interface so the central wiring layer can compose them without the
// proxy package depending on transport packages.
package router

import (
	"context"
	"errors"
	"hash/fnv"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

)

// SelectionReason identifies why a selector chose a particular candidate.
// Reasons are stable strings used by the observability layer.
type SelectionReason string

const (
	ReasonPreferred      SelectionReason = "preferred"
	ReasonSticky         SelectionReason = "sticky"
	ReasonRoundRobin     SelectionReason = "round_robin"
	ReasonDirect         SelectionReason = "direct_forced"
	ReasonProxy          SelectionReason = "proxy"
	ReasonProxyBusy      SelectionReason = "proxy_busy_direct"
	ReasonProxyUnhealthy SelectionReason = "proxy_unhealthy_direct"
	ReasonProxyDisabled  SelectionReason = "proxy_disabled_direct"
)

// SelectionDecision records the selector's reasoning alongside the chosen
// candidate. It is emitted to the observability layer and persisted in
// request telemetry.
type SelectionDecision struct {
	CandidateID          string
	Reason               SelectionReason
	AffinityKey          string
	ChosenAt             time.Time
	ExcludedCandidateIDs []string
}

// ProviderSelector picks one provider from a candidate set. It is used by
// callers that operate above the account pool (e.g. load balancing across
// model providers).
type ProviderSelector interface {
	Select(ctx context.Context, candidates []ProviderCandidate, affinity AffinityKey) (ProviderCandidate, SelectionDecision, error)
}

// ProviderCandidate is a provider-level candidate. It deliberately does not
// include credentials — credential selection happens downstream.
type ProviderCandidate struct {
	ID             string
	Model          string
	Priority       int
	UsageHeadroom  float64 // 0..1, higher is more headroom
	StickyAffinity bool
}

// NetworkSelector decides whether to send traffic direct or via an outbound
// proxy, given the current health of the candidate proxies.
type NetworkSelector interface {
	Select(ctx context.Context, in SelectNetworkInput) (NetworkSelection, error)
}

// AffinityKey is the namespace+value pair used by deterministic rendezvous
// hashing. Mirrors the legacy Application contracts.
type AffinityKey struct {
	Namespace string
	Value     string
}

// String returns the compact, unambiguous form of an affinity key.
func (a AffinityKey) String() string {
	return a.Namespace + ":" + a.Value
}

// ErrNoCandidate is returned when a selector has nothing to choose from.
var ErrNoCandidate = errors.New("proxy: no selector candidate")

// RendezvousSelector orders candidates by FNV-1a 32-bit rendezvous score.
// Ties resolve by id ascending, so the result is deterministic regardless
// of the input order.
type RendezvousSelector struct{}

// NewRendezvousSelector constructs a selector with no state.
func NewRendezvousSelector() *RendezvousSelector { return &RendezvousSelector{} }

// Select orders the candidates by rendezvous score for the supplied
// affinity key and returns the highest-scoring candidate.
func (s *RendezvousSelector) Select(ctx context.Context, candidates []ProviderCandidate, affinity AffinityKey) (ProviderCandidate, SelectionDecision, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return ProviderCandidate{}, SelectionDecision{}, err
	}
	if len(candidates) == 0 {
		return ProviderCandidate{}, SelectionDecision{}, ErrNoCandidate
	}
	key := affinity.String()
	ordered := orderByRendezvous(key, candidates, func(c ProviderCandidate) string { return c.ID })
	if err := ctx.Err(); err != nil {
		return ProviderCandidate{}, SelectionDecision{}, err
	}
	top := ordered[0]
	reason := ReasonPreferred
	switch {
	case affinity.Namespace != "" && top.StickyAffinity:
		reason = ReasonSticky
	case len(ordered) > 1:
		reason = ReasonRoundRobin
	}
	return top, SelectionDecision{
		CandidateID: top.ID,
		Reason:      reason,
		AffinityKey: key,
		ChosenAt:    time.Now(),
	}, nil
}

// rendezvousScore computes FNV-1a 32-bit over `key\0candidateID`. Pure
// integer arithmetic; stable on every platform.
func rendezvousScore(key, candidateID string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(candidateID))
	return h.Sum32()
}

// orderByRendezvous sorts items in descending score order, ties broken by
// id ascending. It does not mutate the input slice.
func orderByRendezvous[T any](key string, items []T, idOf func(T) string) []T {
	type scored struct {
		item  T
		score uint32
		id    string
	}
	scores := make([]scored, len(items))
	for i, item := range items {
		scores[i] = scored{item: item, score: rendezvousScore(key, idOf(item)), id: idOf(item)}
	}
	sort.SliceStable(scores, func(i, j int) bool {
		if scores[i].score != scores[j].score {
			return scores[i].score > scores[j].score
		}
		return scores[i].id < scores[j].id
	})
	out := make([]T, len(items))
	for i, s := range scores {
		out[i] = s.item
	}
	return out
}

// SelectNetworkInput is the input to NetworkSelector.Select.
type SelectNetworkInput struct {
	ProviderID string
	Mode       NetworkMode
	Policy     NetworkRoutingPolicy
	Proxies    []ProxyEndpoint
	Health     ProxyHealthLookup
}

// NetworkMode declares whether the runtime wants direct or proxied traffic.
type NetworkMode string

const (
	NetworkModeAuto   NetworkMode = "auto"
	NetworkModeDirect NetworkMode = "direct"
	NetworkModeProxy  NetworkMode = "proxy"
)

// NetworkRoutingPolicy encodes the user's intent for proxy fallback.
type NetworkRoutingPolicy string

const (
	RoutingPresetAuto    NetworkRoutingPolicy = "auto"
	RoutingPresetUser    NetworkRoutingPolicy = "target-user"
	RoutingPresetConcurr NetworkRoutingPolicy = "target-concurrent"
)

// ProxyEndpoint describes one outbound proxy candidate.
type ProxyEndpoint struct {
	ID      string
	URL     string
	Enabled bool
	// MaxConcurrency is the per-proxy concurrency ceiling. Non-positive
	// means unlimited.
	MaxConcurrency int
}

// ProxyHealthLookup exposes the runtime's view of proxy health.
type ProxyHealthLookup interface {
	// IsHealthy reports whether the proxy is currently selectable.
	IsHealthy(proxyID string, now time.Time) bool
	// IsEnabled reports whether the proxy is administratively enabled.
	IsEnabled(proxyID string) bool
}

// NetworkSelection is the chosen route.
type NetworkSelection struct {
	UseProxy bool
	ProxyID  string
	Reason   SelectionReason
	// Release returns the proxy slot acquired for this selection. It is safe
	// to call more than once; request/transport lifecycles own the token.
	Release func()
}

// DefaultNetworkSelector implements NetworkSelector with deterministic
// preference ordering: user-disabled > unhealthy > busy > healthy.
type DefaultNetworkSelector struct {
	mu      sync.Mutex
	slots   map[string]int // proxyID → active slots
	maxSlot map[string]int // proxyID → configured max
}

// NewDefaultNetworkSelector constructs a stateless network selector.
func NewDefaultNetworkSelector() *DefaultNetworkSelector {
	return &DefaultNetworkSelector{
		slots:   make(map[string]int),
		maxSlot: make(map[string]int),
	}
}

// SetCapacity informs the selector of each proxy's max concurrency. Callers
// wire this from the runtime configuration.
func (s *DefaultNetworkSelector) SetCapacity(proxyID string, maxConcurrency int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxSlot[proxyID] = maxConcurrency
}

// Acquire reserves a concurrency slot on a proxy. Returns a release function.
func (s *DefaultNetworkSelector) Acquire(proxyID string) (release func(), ok bool) {
	return s.acquire(proxyID, 0)
}

// acquire is the selection-boundary form of Acquire. An endpoint-local
// positive limit takes precedence over the configured limit, while a
// non-positive endpoint limit leaves the configured limit unchanged.
func (s *DefaultNetworkSelector) acquire(proxyID string, endpointLimit int) (release func(), ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	max, hasMax := s.maxSlot[proxyID]
	if endpointLimit > 0 {
		max, hasMax = endpointLimit, true
	}
	if hasMax && max > 0 && s.slots[proxyID] >= max {
		return func() {}, false
	}
	s.slots[proxyID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.slots[proxyID] > 0 {
				s.slots[proxyID]--
			}
		})
	}, true
}

// Select picks direct or proxy according to the input. The rules are:
//
//   - mode == direct → NetworkSelection{UseProxy: false, Reason: direct_forced}.
//   - mode == proxy  → pick the first healthy enabled proxy; fall back to
//     direct if none is available, with a reason explaining why.
//   - mode == auto   → prefer proxy when health allows; otherwise direct.
func (s *DefaultNetworkSelector) Select(ctx context.Context, in SelectNetworkInput) (NetworkSelection, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return NetworkSelection{}, err
	}
	switch in.Mode {
	case NetworkModeDirect:
		return NetworkSelection{UseProxy: false, Reason: ReasonDirect}, nil
	case NetworkModeProxy, NetworkModeAuto:
	default:
		return NetworkSelection{UseProxy: false, Reason: ReasonDirect}, nil
	}

	now := time.Now()
	sawUnhealthy := false
	sawBusy := false
	for _, p := range in.Proxies {
		if err := ctx.Err(); err != nil {
			return NetworkSelection{}, err
		}
		if !p.Enabled {
			continue
		}
		if in.Health != nil && !in.Health.IsEnabled(p.ID) {
			continue
		}
		if in.Health != nil && !in.Health.IsHealthy(p.ID, now) {
			sawUnhealthy = true
			continue
		}
		release, ok := s.acquire(p.ID, p.MaxConcurrency)
		if !ok {
			sawBusy = true
			continue
		}
		// Selection owns the slot only if it can return a usable route. A
		// cancellation racing with acquisition must not leak that slot.
		if err := ctx.Err(); err != nil {
			release()
			return NetworkSelection{}, err
		}
		return NetworkSelection{UseProxy: true, ProxyID: p.ID, Reason: ReasonProxy, Release: release}, nil
	}

	if in.Mode == NetworkModeProxy {
		if sawUnhealthy {
			return NetworkSelection{UseProxy: false, Reason: ReasonProxyUnhealthy}, nil
		}
		if sawBusy {
			return NetworkSelection{UseProxy: false, Reason: ReasonProxyBusy}, nil
		}
		return NetworkSelection{UseProxy: false, Reason: ReasonProxyDisabled}, nil
	}
	return NetworkSelection{UseProxy: false, Reason: ReasonDirect}, nil
}

// SafeHostname reports whether the supplied hostname resolves to a private
// or unsafe IP literal. It is used by request sanitization when deciding
// whether a URL is allowed to leave the proxy.
func SafeHostname(host string) bool {
	if host == "" {
		return false
	}
	host = strings.ToLower(host)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return false
	}
	// Apply the same fail-closed rules used by request transport to literal
	// addresses. Hostnames are deliberately not resolved here; the egress
	// policy's request-time resolver is the authority for those.
	literal := strings.Trim(host, "[]")
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		literal = strings.Trim(parsedHost, "[]")
	}
	if net.ParseIP(literal) != nil || isNumericHost(literal) || strings.ContainsAny(literal, ":%") {
		return safeLiteralIP(literal)
	}
	return true
}

func safeLiteralIP(host string) bool {
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, cidr := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24",
		"192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"100::/64", "2001:2::/48", "2001:db8::/32", "3fff::/20",
	} {
		if _, network, err := net.ParseCIDR(cidr); err == nil && network.Contains(ip) {
			return false
		}
	}
	return true
}

func isNumericHost(host string) bool {
	if host == "" {
		return false
	}
	for _, r := range host {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}
