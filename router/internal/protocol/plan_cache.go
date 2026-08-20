package protocol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// CacheGeneration is the neutral freshness tuple needed by compatibility
// planning. Concrete cache backends adapt their own generation type at the
// application boundary; protocol never imports a router cache implementation.
type CacheGeneration struct {
	Catalog     uint64
	Credentials uint64
	Health      uint64
	Network     uint64
}

func (g CacheGeneration) IsZero() bool { return g == CacheGeneration{} }

// PlanCacheKey is the bounded, content-free lookup tuple for cached plans.
type PlanCacheKey struct {
	Model         string
	Surface       string
	Capabilities  []string
	Generation    CacheGeneration
	ProviderScope string
	Decision      CompatibilityCacheKey
}

func NewPlanCacheKey(model, surface string, capabilities []string, generation CacheGeneration, provider string) (PlanCacheKey, error) {
	if model == "" || surface == "" || provider == "" || generation.IsZero() {
		return PlanCacheKey{}, fmt.Errorf("invalid plan cache key")
	}
	return PlanCacheKey{Model: model, Surface: surface, Capabilities: append([]string(nil), capabilities...), Generation: generation, ProviderScope: provider}, nil
}

func (k PlanCacheKey) wire() string {
	caps := append([]string(nil), k.Capabilities...)
	sort.Strings(caps)
	raw := strings.Join([]string{
		"v=1",
		"model=" + k.Model,
		"surface=" + k.Surface,
		"caps=" + strings.Join(caps, ","),
		"provider=" + k.ProviderScope,
		fmt.Sprintf("gen=%d/%d/%d/%d", k.Generation.Catalog, k.Generation.Credentials, k.Generation.Health, k.Generation.Network),
			"decision=" + k.Decision.Digest(),
	}, "|")
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// CompatibilityCacheKey is the immutable, content-free cache identity for a
// protocol decision. Every field that can alter request/response wire behavior
// is represented so a cached decision cannot cross a capability boundary.
type CompatibilityCacheKey struct {
	Mode              ProcessingMode
	SourceSurface     Surface
	TargetSurface     Surface
	SourceStream      bool
	TargetStream      bool
	ModelPatch        string
	RequiredRepairs   RepairSet
	Unsupported       FeatureSet
	Lossy             FeatureSet
	CatalogGeneration uint64
	CapabilityVersion uint64
}

func NewCompatibilityCacheKey(decision CompatibilityDecision) (CompatibilityCacheKey, error) {
	if err := decision.Validate(); err != nil {
		return CompatibilityCacheKey{}, err
	}
	key := CompatibilityCacheKey{
		Mode:              decision.Mode,
		SourceSurface:     decision.SourceSurface,
		TargetSurface:     decision.TargetSurface,
		SourceStream:      decision.SourceStream,
		TargetStream:      decision.TargetStream,
		ModelPatch:        decision.ModelPatch,
		RequiredRepairs:   append(RepairSet(nil), decision.RequiredRepairs...),
		Unsupported:       cloneFeatureSet(decision.Unsupported),
		Lossy:             cloneFeatureSet(decision.Lossy),
		CatalogGeneration: decision.CatalogGeneration,
		CapabilityVersion: decision.CapabilityVersion,
	}
	sort.Strings(key.RequiredRepairs)
	return key, nil
}

func (k CompatibilityCacheKey) Clone() CompatibilityCacheKey {
	k.RequiredRepairs = append(RepairSet(nil), k.RequiredRepairs...)
	k.Unsupported = cloneFeatureSet(k.Unsupported)
	k.Lossy = cloneFeatureSet(k.Lossy)
	return k
}

func (k CompatibilityCacheKey) wire() string {
	repairs := append([]string(nil), k.RequiredRepairs...)
	sort.Strings(repairs)
	raw := strings.Join([]string{
		"v=1",
		"mode=" + k.Mode.String(),
		"source=" + string(k.SourceSurface),
		"target=" + string(k.TargetSurface),
		fmt.Sprintf("stream=%t/%t", k.SourceStream, k.TargetStream),
		"model-patch=" + k.ModelPatch,
		"repairs=" + strings.Join(repairs, ","),
		"unsupported=" + featureSetWire(k.Unsupported),
		"lossy=" + featureSetWire(k.Lossy),
		fmt.Sprintf("generation=%d/%d", k.CatalogGeneration, k.CapabilityVersion),
	}, "|")
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// Digest returns a stable bounded identifier suitable for cache adapters and
// diagnostics. It contains no request content.
func (k CompatibilityCacheKey) Digest() string { return k.wire() }

func featureSetWire(set FeatureSet) string {
	requirements, err := set.normalized()
	if err != nil {
		return "invalid"
	}
	parts := make([]string, 0, len(requirements))
	for _, requirement := range requirements {
		parts = append(parts, fmt.Sprintf("%s:%s:%s:%t:%t:%d", requirement.Feature, requirement.SourcePath, requirement.TargetPath, requirement.Semantic, requirement.HasNumeric, requirement.NumericValue))
	}
	return strings.Join(parts, ",")
}

// PlanCacheEntry is an immutable cache result returned by a PlanCacheBackend.
type PlanCacheEntry struct {
	Key       PlanCacheKey
	Value     []byte
	ExpiresAt time.Time
}

// PlanCacheLoader computes one plan on a cache miss.
type PlanCacheLoader func(context.Context, PlanCacheKey) (PlanCacheEntry, error)

// PlanCacheBackend is the narrow cache port required by compatibility planning.
// Implementations own serialization, eviction, persistence, and generation
// adaptation outside protocol.
type PlanCacheBackend interface {
	Get(context.Context, PlanCacheKey) (PlanCacheEntry, error)
	Set(context.Context, PlanCacheKey, []byte, time.Duration) error
}

// PlanCacheMissCoalescer is an optional backend extension for concurrent misses.
type PlanCacheMissCoalescer interface {
	PlanCacheBackend
	GetOrLoad(context.Context, PlanCacheKey, PlanCacheLoader) (PlanCacheEntry, error)
}
