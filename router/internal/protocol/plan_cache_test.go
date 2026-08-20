package protocol

import (
	"context"
	"errors"
	"sync"
	"time"
)

type planTestCache struct {
	mu      sync.Mutex
	entries map[string]PlanCacheEntry
}

func newPlanTestCache() *planTestCache {
	return &planTestCache{entries: make(map[string]PlanCacheEntry)}
}

func (c *planTestCache) Get(ctx context.Context, key PlanCacheKey) (PlanCacheEntry, error) {
	if err := ctx.Err(); err != nil {
		return PlanCacheEntry{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key.wire()]
	if !ok || (!entry.ExpiresAt.IsZero() && time.Now().After(entry.ExpiresAt)) {
		return PlanCacheEntry{}, errors.New("cache miss")
	}
	entry.Value = append([]byte(nil), entry.Value...)
	return entry, nil
}

func (c *planTestCache) Set(ctx context.Context, key PlanCacheKey, value []byte, ttl time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key.wire()] = PlanCacheEntry{Key: key, Value: append([]byte(nil), value...), ExpiresAt: time.Now().Add(ttl)}
	return nil
}
