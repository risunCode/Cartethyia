package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const MaxSharedContentTTL = time.Hour

var (
	ErrResponseCacheIneligible = errors.New("cache: response cache ineligible")
	ErrResponseCacheDisabled   = errors.New("cache: response cache disabled")
)

// ResponseSpec is content-free cache identity metadata. RequestBodyDigest
// must be computed from the final target request and output-affecting options.
type ResponseSpec struct {
	TenantID          string
	SourceSurface     string
	TargetSurface     string
	Provider          string
	Model             string
	RequestBodyDigest string
	Generation        Generation
	Streaming         bool
	HasTools          bool
	Continuation      bool
	LossyProjection   bool
	Incomplete        bool
	HasNativeActions  bool
	Compaction        bool
	Complete          bool
}

// ResponseCache is an opt-in complete-response cache. It stores only full
// validated response bodies and delegates bounds/TTL/generation handling to
// the existing Cache backend.
type ResponseCache struct {
	backend Cache
	shared  *SharedContentStore
	ttl     time.Duration
	enabled bool
}

func NewResponseCache(backend Cache, enabled bool, ttl time.Duration, encryptionKey ...[]byte) (*ResponseCache, error) {
	if backend == nil {
		return nil, errors.New("cache: response backend is required")
	}
	if ttl <= 0 || ttl > MaxSharedContentTTL {
		ttl = MaxSharedContentTTL
	}
	c := &ResponseCache{backend: backend, enabled: enabled, ttl: ttl}
	if len(encryptionKey) > 0 && len(encryptionKey[0]) > 0 {
		shared, err := NewSharedContentStore(backend, encryptionKey[0], 0, ttl)
		if err != nil {
			return nil, err
		}
		c.shared = shared
	}
	return c, nil
}

func (c *ResponseCache) key(spec ResponseSpec) (Key, error) {
	if !c.enabled {
		return Key{}, ErrResponseCacheDisabled
	}
	if strings.TrimSpace(spec.TenantID) == "" || strings.TrimSpace(spec.SourceSurface) == "" || strings.TrimSpace(spec.TargetSurface) == "" || strings.TrimSpace(spec.Provider) == "" || strings.TrimSpace(spec.Model) == "" || strings.TrimSpace(spec.RequestBodyDigest) == "" {
		return Key{}, ErrResponseCacheIneligible
	}
	if spec.Streaming || spec.HasTools || spec.Continuation || spec.LossyProjection || spec.Incomplete || spec.HasNativeActions || spec.Compaction {
		return Key{}, ErrResponseCacheIneligible
	}
	tenantSum := sha256.Sum256([]byte(spec.TenantID))
	digestSum := sha256.Sum256([]byte(spec.RequestBodyDigest))
	return Key{Version: CurrentVersion, Model: spec.Model, Surface: spec.SourceSurface + "->" + spec.TargetSurface,
		Capabilities: []CapabilityRequirement{"response", CapabilityRequirement(hex.EncodeToString(digestSum[:])), CapabilityRequirement(hex.EncodeToString(tenantSum[:]))},
		Generation:   spec.Generation, Scope: Scope{Provider: spec.Provider}, Affinity: AffinityNone}, nil
}

func (c *ResponseCache) Get(ctx context.Context, spec ResponseSpec) (Entry, error) {
	if ctx == nil {
		return Entry{}, ErrInvalidContext
	}
	key, err := c.key(spec)
	if err != nil {
		return Entry{}, err
	}
	if c.shared != nil {
		entry, err := c.shared.Get(ctx, SharedContentSpec{TenantID: spec.TenantID, Namespace: "response", Identity: spec.RequestBodyDigest, Provider: spec.Provider, Model: spec.Model, Surface: string(spec.SourceSurface) + "->" + string(spec.TargetSurface), Generation: spec.Generation})
		if err == nil {
			entry.HitReason = HitReasonResponse
			entry.Hit = true
		}
		return entry, err
	}
	entry, err := c.backend.Get(ctx, key)
	if err != nil && ctx != nil && ctx.Err() != nil {
		return Entry{}, ctx.Err()
	}
	if err != nil {
		return Entry{}, &MissError{Key: key, Reason: "unavailable"}
	}
	entry.Hit = true
	entry.HitReason = HitReasonResponse
	return entry, nil
}

func (c *ResponseCache) Set(ctx context.Context, spec ResponseSpec, body []byte) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	if len(body) == 0 || !json.Valid(body) {
		return ErrResponseCacheIneligible
	}
	key, err := c.key(spec)
	if err != nil {
		return err
	}
	if c.shared != nil {
		return c.shared.Set(ctx, SharedContentSpec{TenantID: spec.TenantID, Namespace: "response", Identity: spec.RequestBodyDigest, Provider: spec.Provider, Model: spec.Model, Surface: string(spec.SourceSurface) + "->" + string(spec.TargetSurface), Generation: spec.Generation}, body)
	}
	if err := c.backend.Set(ctx, key, body, c.ttl); err != nil {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		return nil
	}
	return nil
}

// Delete removes a response entry without exposing tenant or identity values
// to the backend caller. Deletion is advisory and idempotent.
func (c *ResponseCache) Delete(ctx context.Context, spec ResponseSpec) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	key, err := c.key(spec)
	if err != nil {
		return err
	}
	if c.shared != nil {
		return c.shared.Delete(ctx, SharedContentSpec{TenantID: spec.TenantID, Namespace: "response", Identity: spec.RequestBodyDigest, Provider: spec.Provider, Model: spec.Model, Surface: string(spec.SourceSurface) + "->" + string(spec.TargetSurface), Generation: spec.Generation})
	}
	if err := c.backend.Delete(ctx, key); err != nil && ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

// SetValidated stores only a complete response that has passed the production
// source encoder/decoder validation callback. A nil validator is rejected so
// callers cannot accidentally turn an unvalidated provider body into a hit.
func (c *ResponseCache) SetValidated(ctx context.Context, spec ResponseSpec, body []byte, validate func([]byte) error) error {
	if validate == nil || spec.Complete == false || spec.Streaming || spec.HasTools || spec.HasNativeActions || spec.Continuation || spec.Incomplete || spec.Compaction || spec.LossyProjection {
		return ErrResponseCacheIneligible
	}
	if err := validate(body); err != nil {
		return ErrResponseCacheIneligible
	}
	return c.Set(ctx, spec, body)
}
