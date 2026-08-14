package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Version identifies the on-the-wire layout of a Key. Bumping Version is the
// explicit migration path described in design §8.3 ("Keys are versioned and
// generation-aware"); a new version discards entries recorded under older
// versions automatically because the wire fingerprint differs.
type Version uint8

// CurrentVersion is the only Version accepted by Memory. Other backends may
// negotiate additional values; callers should use NewKey with
// cache.CurrentVersion.
const CurrentVersion Version = 1

// CapabilityRequirement names a capability the resolved route must satisfy
// (tools, images, reasoning, streaming, prompt-cache, etc.). The slice is
// normalised into a deterministic fingerprint so callers do not need to sort
// the input themselves.
type CapabilityRequirement string

// Scope carries the credential/account scope required for a resolution. An
// empty AccountID means the entry is valid for any account under the same
// provider.
type Scope struct {
	// Provider identifies the upstream provider family (openai, anthropic, ...).
	Provider string
	// AccountID identifies a specific credential. Empty means scope is
	// "any account within this provider".
	AccountID string
}

// NetworkPolicy describes how the resolved route is allowed to leave the
// process (R-CACHE-04). Policy fingerprints are part of the cache key so
// different egress profiles never share entries.
type NetworkPolicy struct {
	// Profile is a stable identifier (e.g. "default", "compliance-eu"). Empty
	// values are treated as "default".
	Profile string
	// Egress is the egress tag required by the request (e.g. "tor",
	// "datacenter"). Empty values are unconstrained.
	Egress string
}

// CacheAffinityPolicy names how callers prefer a sticky/affine resolution
// vs. a fresh one. Affinity modes that the caller cares about become part of
// the key so a request that requires strong affinity never accidentally
// reuses a "best-effort" entry.
type CacheAffinityPolicy string

const (
	// AffinityNone disables affinity. Entries are interchangeable.
	AffinityNone CacheAffinityPolicy = "none"
	// AffinityStrong keeps the caller pinned to a previously resolved
	// route when the key still resolves.
	AffinityStrong CacheAffinityPolicy = "strong"
)

// Key is the resolution-cache lookup tuple. All fields except Version are
// stable for the lifetime of a request; callers SHOULD construct one Key per
// resolution attempt.
type Key struct {
	// Version is the on-the-wire layout version. Memory enforces the current
	// version. An older version is rejected with ErrInvalidKey.
	Version Version
	// Model is the canonical model identifier resolved by the catalog.
	Model string
	// Surface is the protocol surface (openai-chat, openai-responses,
	// anthropic-messages, ...).
	Surface string
	// Capabilities is the set of features the resolved route must support.
	Capabilities []CapabilityRequirement
	// Generation is the catalog/credential/network generation tuple. Two
	// requests under different generations MUST resolve independently and
	// MUST NOT share entries (R-CACHE-04).
	Generation Generation
	// Scope is the credential/account scope.
	Scope Scope
	// Network describes the egress policy the resolution must respect.
	Network NetworkPolicy
	// Affinity is the cache-affinity policy.
	Affinity CacheAffinityPolicy
}

// Wire returns the canonical, deterministic string fingerprint used as the
// actual map key. The fingerprint is stable across processes and Go versions.
//
// Generation is intentionally NOT part of the wire fingerprint: the wire
// identifies the shape of the resolution request while the generation is the
// freshness stamp recorded alongside the entry. The cache layer rejects
// lookups whose requested generation does not match the stored entry's
// generation (R-CACHE-04, R-CACHE-05).
func (k Key) Wire() string {
	capNames := make([]string, len(k.Capabilities))
	for i, c := range k.Capabilities {
		capNames[i] = string(c)
	}
	sort.Strings(capNames)

	affinity := k.Affinity
	if affinity == "" {
		affinity = AffinityNone
	}
	network := k.Network
	if network.Profile == "" {
		network.Profile = "default"
	}

	raw := strings.Join([]string{
		fmt.Sprintf("v=%d", k.Version),
		"model=" + k.Model,
		"surface=" + k.Surface,
		"caps=" + strings.Join(capNames, ","),
		fmt.Sprintf("provider=%s", k.Scope.Provider),
		fmt.Sprintf("account=%s", k.Scope.AccountID),
		fmt.Sprintf("net=%s/%s", network.Profile, network.Egress),
		"affinity=" + string(affinity),
	}, "|")

	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// validate ensures required fields are populated.
func (k Key) validate() error {
	if k.Version == 0 {
		return fmt.Errorf("%w: version must be non-zero", ErrInvalidKey)
	}
	if k.Version != CurrentVersion {
		return fmt.Errorf("%w: version %d is not supported (current=%d)", ErrInvalidKey, k.Version, CurrentVersion)
	}
	if k.Model == "" {
		return fmt.Errorf("%w: model is required", ErrInvalidKey)
	}
	if k.Surface == "" {
		return fmt.Errorf("%w: surface is required", ErrInvalidKey)
	}
	if k.Scope.Provider == "" {
		return fmt.Errorf("%w: scope.provider is required", ErrInvalidKey)
	}
	if k.Generation.IsZero() {
		return fmt.Errorf("%w: generation is required", ErrInvalidKey)
	}
	return nil
}

// NewKey constructs a Key against the current version. Missing required
// fields produce an error rather than a silently-empty fingerprint.
func NewKey(model, surface string, capabilities []CapabilityRequirement, generation Generation, scope Scope, network NetworkPolicy, affinity CacheAffinityPolicy) (Key, error) {
	k := Key{
		Version:      CurrentVersion,
		Model:        model,
		Surface:      surface,
		Capabilities: append([]CapabilityRequirement(nil), capabilities...),
		Generation:   generation,
		Scope:        scope,
		Network:      network,
		Affinity:     affinity,
	}
	if err := k.validate(); err != nil {
		return Key{}, err
	}
	return k, nil
}
