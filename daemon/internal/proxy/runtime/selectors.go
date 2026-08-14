// File: selectors.go
// Provider / credential / network selection primitives. Each selector is a
// narrow interface so the central wiring layer can compose them without the
// proxy package depending on transport packages.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/security/outbound"
)

const maxSelectionFallback = 64

// SelectionReason identifies why a selector chose a particular candidate.
// Reasons are stable strings used by the observability layer.
type SelectionReason string

const (
	ReasonPreferred      SelectionReason = "preferred"
	ReasonSticky         SelectionReason = "sticky"
	ReasonRoundRobin     SelectionReason = "round_robin"
	ReasonLeastLoaded    SelectionReason = "least_loaded"
	ReasonHeadroom       SelectionReason = "usage_headroom"
	ReasonFallback       SelectionReason = "fallback"
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

// AccountSelectionCandidate is the bounded, secret-free input to account
// selection. Negative flags are intentionally explicit so an omitted health
// or quota observation does not accidentally make an account unavailable.
type AccountSelectionCandidate struct {
	ID       string
	Provider string
	Model    string

	// Enabled, Authorized, Compatible and QuotaAvailable are admission
	// predicates. Callers must set them from the immutable catalog snapshot.
	Enabled        bool
	Authorized     bool
	Compatible     bool
	QuotaAvailable bool

	// Quarantined and Disabled are operator overrides. They are never cleared
	// by automatic recovery.
	Quarantined bool
	Disabled    bool

	// Health/cooldown is evaluated before ranking. StateHealthy and an empty
	// state both mean that no negative health observation is present.
	Health        AccountState
	CooldownUntil time.Time
	ModelLocks    map[string]time.Time

	Priority       int
	UsageHeadroom  float64
	Load           int
	StickyAffinity bool
}

// AccountSelectionInput controls deterministic account ranking.
type AccountSelectionInput struct {
	Provider           string
	Model              string
	PreferredAccountID string
	Affinity           AffinityKey
	MaxFallback        int
	Now                time.Time
}

// ErrInvalidCandidate is returned when candidate metadata cannot be selected.
var ErrInvalidCandidate = errors.New("proxy: invalid selector candidate")

// SelectAccountCandidate chooses one eligible account using explicit
// preference, sticky rendezvous affinity, priority, quota headroom, load and
// stable ID tie-breaking. The input is never mutated.
func SelectAccountCandidate(ctx context.Context, in AccountSelectionInput, candidates []AccountSelectionCandidate) (AccountSelectionCandidate, SelectionDecision, error) {
	ordered, decision, err := RankAccountCandidates(ctx, in, candidates)
	if err != nil {
		return AccountSelectionCandidate{}, SelectionDecision{}, err
	}
	if len(ordered) == 0 {
		return AccountSelectionCandidate{}, SelectionDecision{}, ErrNoCandidate
	}
	decision.CandidateID = ordered[0].ID
	return ordered[0], decision, nil
}

// RankAccountCandidates returns at most MaxFallback eligible candidates in
// deterministic attempt order. This is the bounded fallback list consumed by
// the router; it is deliberately separate from failure classification.
func RankAccountCandidates(ctx context.Context, in AccountSelectionInput, candidates []AccountSelectionCandidate) ([]AccountSelectionCandidate, SelectionDecision, error) {
	if err := ctx.Err(); err != nil {
		return nil, SelectionDecision{}, fmt.Errorf("%w: %v", ErrSelectionCanceled, err)
	}
	key := in.Affinity.String()
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	limit := in.MaxFallback
	if limit <= 0 || limit > maxSelectionFallback {
		limit = maxSelectionFallback
	}

	eligible := make([]AccountSelectionCandidate, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	excluded := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.ID == "" {
			return nil, SelectionDecision{}, fmt.Errorf("%w: empty candidate id", ErrInvalidCandidate)
		}
		if _, ok := seen[candidate.ID]; ok {
			return nil, SelectionDecision{}, fmt.Errorf("%w: duplicate candidate id %q", ErrInvalidCandidate, candidate.ID)
		}
		seen[candidate.ID] = struct{}{}
		if in.Provider != "" && candidate.Provider != in.Provider {
			excluded = append(excluded, candidate.ID)
			continue
		}
		if in.Model != "" && candidate.Model != "" && candidate.Model != in.Model {
			excluded = append(excluded, candidate.ID)
			continue
		}
		if !accountCandidateEligible(candidate, in.Model, now) {
			excluded = append(excluded, candidate.ID)
			continue
		}
		eligible = append(eligible, candidate)
	}
	if len(eligible) == 0 {
		return nil, SelectionDecision{AffinityKey: key, ExcludedCandidateIDs: excluded}, ErrNoCandidate
	}

	sticky := key != ":" && hasStickyCandidate(eligible)
	headroom := hasHeadroom(eligible)
	sort.SliceStable(eligible, func(i, j int) bool {
		left, right := eligible[i], eligible[j]
		if left.ID == in.PreferredAccountID || right.ID == in.PreferredAccountID {
			return left.ID == in.PreferredAccountID
		}
		if sticky && left.StickyAffinity != right.StickyAffinity {
			return left.StickyAffinity
		}
		if sticky && left.StickyAffinity && right.StickyAffinity {
			ls, rs := rendezvousScore(key, left.ID), rendezvousScore(key, right.ID)
			if ls != rs {
				return ls > rs
			}
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if headroom && left.UsageHeadroom != right.UsageHeadroom {
			return left.UsageHeadroom > right.UsageHeadroom
		}
		if left.Load != right.Load {
			return left.Load < right.Load
		}
		return left.ID < right.ID
	})
	if len(eligible) > limit {
		excluded = append(excluded, idsOf(eligible[limit:])...)
		eligible = eligible[:limit]
	}

	reason := ReasonFallback
	switch {
	case eligible[0].ID == in.PreferredAccountID:
		reason = ReasonPreferred
	case sticky && eligible[0].StickyAffinity:
		reason = ReasonSticky
	case headroom:
		reason = ReasonHeadroom
	case eligible[0].Load > 0:
		reason = ReasonLeastLoaded
	case len(eligible) == 1:
		reason = ReasonPreferred
	}
	return eligible, SelectionDecision{
		CandidateID:          eligible[0].ID,
		Reason:               reason,
		AffinityKey:          key,
		ChosenAt:             time.Now(),
		ExcludedCandidateIDs: excluded,
	}, nil
}

func accountCandidateEligible(candidate AccountSelectionCandidate, model string, now time.Time) bool {
	if !candidate.Enabled || !candidate.Authorized || !candidate.Compatible ||
		!candidate.QuotaAvailable || candidate.Disabled || candidate.Quarantined {
		return false
	}
	switch candidate.Health {
	case StateCoolingDown, StateError, StateDisabled, StateExhausted:
		return false
	}
	if !candidate.CooldownUntil.IsZero() && candidate.CooldownUntil.After(now) {
		return false
	}
	if model != "" {
		if retryAt, ok := candidate.ModelLocks[model]; ok && retryAt.After(now) {
			return false
		}
	}
	return true
}

func hasStickyCandidate(candidates []AccountSelectionCandidate) bool {
	for _, candidate := range candidates {
		if candidate.StickyAffinity {
			return true
		}
	}
	return false
}

func hasHeadroom(candidates []AccountSelectionCandidate) bool {
	for _, candidate := range candidates {
		if candidate.UsageHeadroom > 0 {
			return true
		}
	}
	return false
}

func idsOf(candidates []AccountSelectionCandidate) []string {
	ids := make([]string, len(candidates))
	for i, candidate := range candidates {
		ids[i] = candidate.ID
	}
	return ids
}

// CredentialSelector picks one credential from an account candidate set. The
// default implementation defers to the pool but the interface exists so the
// runtime can plug in OAuth, API-key, or service-account resolvers.
type CredentialSelector interface {
	Select(ctx context.Context, candidates []Account, affinity AffinityKey) (*Account, SelectionDecision, error)
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
// ErrSelectionCanceled identifies a canceled selection operation.
var ErrSelectionCanceled = errors.New("proxy: selection canceled")
var ErrNoCandidate = errors.New("proxy: no selector candidate")

// RendezvousSelector orders candidates by FNV-1a 32-bit rendezvous score.
// Ties resolve by id ascending, so the result is deterministic regardless
// of the input order.
type RendezvousSelector struct{}

// NewRendezvousSelector constructs a selector with no state.
func NewRendezvousSelector() *RendezvousSelector { return &RendezvousSelector{} }

// Select orders the candidates by rendezvous score for the supplied
// affinity key and returns the highest-scoring candidate.
func (s *RendezvousSelector) Select(_ context.Context, candidates []ProviderCandidate, affinity AffinityKey) (ProviderCandidate, SelectionDecision, error) {
	if len(candidates) == 0 {
		return ProviderCandidate{}, SelectionDecision{}, ErrNoCandidate
	}
	key := affinity.String()
	ordered := orderByRendezvous(key, candidates, func(c ProviderCandidate) string { return c.ID })
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

// PoolBackedCredentialSelector defers credential selection to the AccountPool.
// It is the default implementation injected by the central wiring layer.
type PoolBackedCredentialSelector struct {
	Pool *AccountPool
	// Mode selects the pool strategy. "round_robin" or "least_loaded".
	Mode string
}

// NewPoolBackedCredentialSelector wires a credential selector to the pool.
func NewPoolBackedCredentialSelector(pool *AccountPool, mode string) *PoolBackedCredentialSelector {
	if mode == "" {
		mode = "round_robin"
	}
	return &PoolBackedCredentialSelector{Pool: pool, Mode: mode}
}

// Select defers to the pool. The returned SelectionDecision is enriched with
// the affinity key so the observability layer can correlate.
func (s *PoolBackedCredentialSelector) Select(ctx context.Context, candidates []Account, affinity AffinityKey) (*Account, SelectionDecision, error) {
	if s.Pool == nil {
		return nil, SelectionDecision{}, errors.New("proxy: nil account pool")
	}
	if len(candidates) == 0 {
		return nil, SelectionDecision{}, ErrNoCandidate
	}
	provider := candidates[0].Provider
	_ = candidates // Pool fetches its own snapshot via the store.

	var (
		acct *Account
		err  error
	)
	switch s.Mode {
	case "least_loaded":
		acct, err = s.Pool.GetByLeastLoad(ctx, provider)
	default:
		acct, err = s.Pool.GetNext(ctx, provider)
	}
	if err != nil {
		return nil, SelectionDecision{}, err
	}
	reason := ReasonRoundRobin
	if s.Mode == "least_loaded" {
		reason = ReasonLeastLoaded
	}
	return acct, SelectionDecision{
		CandidateID: acct.ID,
		Reason:      reason,
		AffinityKey: affinity.String(),
		ChosenAt:    time.Now(),
	}, nil
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
	s.mu.Lock()
	defer s.mu.Unlock()
	max, hasMax := s.maxSlot[proxyID]
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
func (s *DefaultNetworkSelector) Select(_ context.Context, in SelectNetworkInput) (NetworkSelection, error) {
	switch in.Mode {
	case NetworkModeDirect:
		return NetworkSelection{UseProxy: false, Reason: ReasonDirect}, nil
	case NetworkModeProxy, NetworkModeAuto:
	default:
		return NetworkSelection{UseProxy: false, Reason: ReasonDirect}, nil
	}

	now := time.Now()
	for _, p := range in.Proxies {
		if !p.Enabled {
			continue
		}
		if in.Health != nil && !in.Health.IsEnabled(p.ID) {
			continue
		}
		if in.Health != nil && !in.Health.IsHealthy(p.ID, now) {
			if in.Mode == NetworkModeProxy {
				return NetworkSelection{UseProxy: false, Reason: ReasonProxyUnhealthy}, nil
			}
			continue
		}
		release, ok := s.Acquire(p.ID)
		if !ok {
			if in.Mode == NetworkModeProxy {
				return NetworkSelection{UseProxy: false, Reason: ReasonProxyBusy}, nil
			}
			continue
		}
		return NetworkSelection{UseProxy: true, ProxyID: p.ID, Reason: ReasonProxy, Release: release}, nil
	}

	if in.Mode == NetworkModeProxy {
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
	// Apply the same fail-closed outbound policy used by request transport to
	// literal addresses. Hostnames are deliberately not resolved here; the
	// policy's request-time resolver is the authority for those.
	literal := strings.Trim(host, "[]")
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		literal = strings.Trim(parsedHost, "[]")
	}
	if net.ParseIP(literal) != nil || isNumericHost(literal) || strings.ContainsAny(literal, ":%") {
		urlHost := host
		if parsedHost, port, err := net.SplitHostPort(host); err == nil {
			urlHost = net.JoinHostPort(parsedHost, port)
		} else if strings.Contains(literal, ":") && !strings.HasPrefix(host, "[") {
			urlHost = "[" + literal + "]"
		}
		_, err := (outbound.Policy{}).Validate(context.Background(), "http://"+urlHost)
		return err == nil
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
