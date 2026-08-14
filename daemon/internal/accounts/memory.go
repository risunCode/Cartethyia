package accounts

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// MemorySecretStore is an in-memory SecretStore for tests and for
// short-lived processes that have not yet wired the durable backend.
// Production deployments must use an encrypted backend.
type MemorySecretStore struct {
	mu      sync.RWMutex
	access  map[string]*Secret
	refresh map[string]*Secret
}

// NewMemorySecretStore returns a ready-to-use in-memory store.
func NewMemorySecretStore() *MemorySecretStore {
	return &MemorySecretStore{
		access:  make(map[string]*Secret),
		refresh: make(map[string]*Secret),
	}
}

// PutAccess stores a defensive copy of the access token and consumes the
// caller-owned Secret, including on validation failure.
func (m *MemorySecretStore) PutAccess(_ context.Context, accountID string, secret *Secret) error {
	if secret == nil || secret.IsZero() {
		if secret != nil {
			secret.Close()
		}
		return NewError(ErrKindInvalidRequest, "", accountID, errors.New("access secret must not be empty"))
	}
	if accountID == "" {
		secret.Close()
		return NewError(ErrKindInvalidRequest, "", accountID, errors.New("accountID must not be empty"))
	}
	replacement := NewSecret(secret.Reveal())
	secret.Close()
	m.mu.Lock()
	defer m.mu.Unlock()
	if prev, ok := m.access[accountID]; ok {
		prev.Close()
	}
	m.access[accountID] = replacement
	return nil
}

// PutRefresh stores a defensive copy of the refresh token and consumes the
// caller-owned Secret. An empty secret clears the slot.
func (m *MemorySecretStore) PutRefresh(_ context.Context, accountID string, secret *Secret) error {
	if accountID == "" {
		if secret != nil {
			secret.Close()
		}
		return NewError(ErrKindInvalidRequest, "", accountID, errors.New("accountID must not be empty"))
	}
	var replacement *Secret
	if secret != nil && !secret.IsZero() {
		replacement = NewSecret(secret.Reveal())
	}
	if secret != nil {
		secret.Close()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if prev, ok := m.refresh[accountID]; ok {
		prev.Close()
	}
	if replacement == nil {
		delete(m.refresh, accountID)
		return nil
	}
	m.refresh[accountID] = replacement
	return nil
}

// GetAccess returns a defensive copy of the access token.
func (m *MemorySecretStore) GetAccess(_ context.Context, accountID string) (*Secret, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur, ok := m.access[accountID]
	if !ok {
		return nil, ErrSecretNotFound
	}
	return NewSecret(cur.Reveal()), nil
}

// GetRefresh returns a defensive copy of the refresh token.
func (m *MemorySecretStore) GetRefresh(_ context.Context, accountID string) (*Secret, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur, ok := m.refresh[accountID]
	if !ok {
		return nil, ErrSecretNotFound
	}
	return NewSecret(cur.Reveal()), nil
}

// Delete removes every secret for the account.
func (m *MemorySecretStore) Delete(_ context.Context, accountID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.access[accountID]; ok {
		cur.Close()
		delete(m.access, accountID)
	}
	if cur, ok := m.refresh[accountID]; ok {
		cur.Close()
		delete(m.refresh, accountID)
	}
	return nil
}

// MemoryRefreshLeaseStore is a process-local fixture implementing the same
// lease semantics expected from a durable backend. It is intentionally not a
// production persistence adapter.
type MemoryRefreshLeaseStore struct {
	mu     sync.Mutex
	next   atomic.Uint64
	leases map[string]memoryRefreshLease
}

type memoryRefreshLease struct {
	owner      string
	generation int64
	until      time.Time
}

type memoryRefreshLeaseHandle struct {
	store      *MemoryRefreshLeaseStore
	account    string
	owner      string
	generation int64
	once       sync.Once
}

// NewMemoryRefreshLeaseStore returns an empty lease fixture.
func NewMemoryRefreshLeaseStore() *MemoryRefreshLeaseStore {
	return &MemoryRefreshLeaseStore{leases: make(map[string]memoryRefreshLease)}
}

func (m *MemoryRefreshLeaseStore) Acquire(ctx context.Context, accountID, _ string, ttl time.Duration) (RefreshLeaseHandle, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if accountID == "" || ttl <= 0 {
		return nil, false, NewError(ErrKindInvalidRequest, "", accountID, errors.New("invalid refresh lease request"))
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.leases[accountID]; ok && now.Before(current.until) {
		return nil, false, nil
	}
	owner := fmt.Sprintf("lease-%d", m.next.Add(1))
	generation := int64(m.next.Load())
	m.leases[accountID] = memoryRefreshLease{owner: owner, generation: generation, until: now.Add(ttl)}
	return &memoryRefreshLeaseHandle{store: m, account: accountID, owner: owner, generation: generation}, true, nil
}

func (h *memoryRefreshLeaseHandle) Fence() RefreshFence {
	if h == nil {
		return RefreshFence{}
	}
	return RefreshFence{OwnerID: h.owner, Generation: h.generation}
}

func (h *memoryRefreshLeaseHandle) Renew(ctx context.Context, ttl time.Duration) error {
	if h == nil || h.store == nil {
		return nil
	}
	ok, err := h.store.Renew(ctx, h.account, h.Fence(), ttl)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("refresh lease: ownership lost")
	}
	return nil
}

func (m *MemoryRefreshLeaseStore) Renew(ctx context.Context, accountID string, fence RefreshFence, ttl time.Duration) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if accountID == "" || fence.OwnerID == "" || fence.Generation <= 0 || ttl <= 0 {
		return false, NewError(ErrKindInvalidRequest, "", accountID, errors.New("invalid refresh lease renewal"))
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.leases[accountID]
	if !ok || current.owner != fence.OwnerID || current.generation != fence.Generation || !now.Before(current.until) {
		return false, nil
	}
	current.until = now.Add(ttl)
	m.leases[accountID] = current
	return true, nil
}

func (h *memoryRefreshLeaseHandle) Release(ctx context.Context) error {
	if h == nil || h.store == nil {
		return nil
	}
	var err error
	h.once.Do(func() {
		if contextErr := ctx.Err(); contextErr != nil {
			err = contextErr
			return
		}
		h.store.mu.Lock()
		defer h.store.mu.Unlock()
		if current, ok := h.store.leases[h.account]; ok && current.owner == h.owner && current.generation == h.generation {
			delete(h.store.leases, h.account)
		}
	})
	return err
}

// MemoryRecordStore is an in-memory RecordStore.
type MemoryRecordStore struct {
	mu      sync.RWMutex
	records map[string]*OAuthTokenRecord
}

// NewMemoryRecordStore returns a ready-to-use in-memory store.
func NewMemoryRecordStore() *MemoryRecordStore {
	return &MemoryRecordStore{
		records: make(map[string]*OAuthTokenRecord),
	}
}

// Put writes the record, overwriting any prior version.
func (m *MemoryRecordStore) Put(_ context.Context, record *OAuthTokenRecord) error {
	if record == nil {
		return NewError(ErrKindInvalidRequest, "", "", errors.New("record must not be nil"))
	}
	if record.AccountID == "" {
		return NewError(ErrKindInvalidRequest, record.ProviderID, "", errors.New("record.AccountID must not be empty"))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := *record
	m.records[record.AccountID] = &clone
	return nil
}

// Get returns a defensive copy of the record.
func (m *MemoryRecordStore) Get(_ context.Context, accountID string) (*OAuthTokenRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur, ok := m.records[accountID]
	if !ok {
		return nil, ErrRecordNotFound
	}
	clone := *cur
	return &clone, nil
}

// Delete removes the record. Idempotent.
func (m *MemoryRecordStore) Delete(_ context.Context, accountID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.records, accountID)
	return nil
}

// CompareAndSwap writes the record only when the persisted Version
// matches expectedVersion. A negative expectedVersion requires an empty
// slot; zero or positive values require an exact Version match. The
// write bumps Version to expectedVersion+1 when it succeeds.
func (m *MemoryRecordStore) CompareAndSwap(_ context.Context, expectedVersion int64, record *OAuthTokenRecord) error {
	if record == nil {
		return NewError(ErrKindInvalidRequest, "", "", errors.New("record must not be nil"))
	}

	if record.AccountID == "" {
		return NewError(ErrKindInvalidRequest, record.ProviderID, "", errors.New("record.AccountID must not be empty"))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, exists := m.records[record.AccountID]
	if expectedVersion < 0 {
		if exists {
			return ErrVersionMismatch
		}
	} else {
		if !exists || cur.Version != expectedVersion {
			return ErrVersionMismatch
		}
	}
	clone := *record
	clone.Version = expectedVersion + 1
	m.records[record.AccountID] = &clone
	return nil
}

// List returns a snapshot of every record.
func (m *MemoryRecordStore) List(_ context.Context) ([]*OAuthTokenRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*OAuthTokenRecord, 0, len(m.records))
	for _, r := range m.records {
		clone := *r
		out = append(out, &clone)
	}
	return out, nil
}

// MemoryAccountConfigStore is an in-memory AccountConfigStore.
type MemoryAccountConfigStore struct {
	mu    sync.RWMutex
	confs map[string]*AccountConfig
}

// NewMemoryAccountConfigStore returns a ready-to-use in-memory store.
func NewMemoryAccountConfigStore() *MemoryAccountConfigStore {
	return &MemoryAccountConfigStore{
		confs: make(map[string]*AccountConfig),
	}
}

// Put stores non-secret account metadata. The reference defaults to the
// account id so callers can resolve it without handling token material.
func (m *MemoryAccountConfigStore) Put(_ context.Context, cfg *AccountConfig) error {
	if cfg == nil {
		return NewError(ErrKindInvalidRequest, "", "", errors.New("config must not be nil"))
	}
	if err := cfg.Validate(); err != nil {
		return NewError(ErrKindInvalidRequest, cfg.ProviderID, cfg.ID, err)
	}
	clone := *cfg
	if clone.CredentialRef.IsZero() {
		ref, err := NewReference(clone.ID)
		if err != nil {
			return NewError(ErrKindInvalidRequest, clone.ProviderID, clone.ID, err)
		}
		clone.CredentialRef = ref
	}
	if cfg.Labels != nil {
		clone.Labels = make(map[string]string, len(cfg.Labels))
		for k, v := range cfg.Labels {
			clone.Labels[k] = v
		}
	}
	if cfg.Scopes != nil {
		clone.Scopes = append([]string(nil), cfg.Scopes...)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.confs[cfg.ID] = &clone
	return nil
}

// Get returns a defensive copy of the config.
func (m *MemoryAccountConfigStore) Get(_ context.Context, id string) (*AccountConfig, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur, ok := m.confs[id]
	if !ok {
		return nil, ErrAccountNotFound
	}
	return cloneConfig(cur), nil
}
func (m *MemoryAccountConfigStore) List(_ context.Context) ([]*AccountConfig, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.confs))
	for id := range m.confs {
		ids = append(ids, id)
	}
	sortStrings(ids)
	out := make([]*AccountConfig, 0, len(ids))
	for _, id := range ids {
		if cur, ok := m.confs[id]; ok {
			out = append(out, cloneConfig(cur))
		}
	}
	return out, nil
}

// Delete removes the config. It is idempotent.
func (m *MemoryAccountConfigStore) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.confs, id)
	return nil
}

// CachedAccountConfigStore wraps an AccountConfigStore with a small
// read-through cache. The cache holds non-secret metadata only. Use this on
// the request path; writes always go through to the underlying store and
// invalidate matching entries.
type CachedAccountConfigStore struct {
	inner AccountConfigStore
	ttl   time.Duration
	max   int

	mu      sync.Mutex
	entries map[string]cachedConfigEntry
}

type cachedConfigEntry struct {
	cfg     *AccountConfig
	expires time.Time
}

// NewCachedAccountConfigStore wraps the supplied store. A zero TTL
// disables caching; a negative TTL is treated as zero.
func NewCachedAccountConfigStore(inner AccountConfigStore, opts AccountConfigCacheOptions) *CachedAccountConfigStore {
	if opts.TTL < 0 {
		opts.TTL = 0
	}
	if opts.MaxEntries < 0 {
		opts.MaxEntries = 0
	}
	return &CachedAccountConfigStore{
		inner:   inner,
		ttl:     opts.TTL,
		max:     opts.MaxEntries,
		entries: make(map[string]cachedConfigEntry),
	}
}

// Put writes through and invalidates any cached entry.
func (c *CachedAccountConfigStore) Put(ctx context.Context, cfg *AccountConfig) error {
	if err := c.inner.Put(ctx, cfg); err != nil {
		return err
	}
	c.invalidate(cfg.ID)
	return nil
}

// Get reads from the cache first, then falls back to the store.
func (c *CachedAccountConfigStore) Get(ctx context.Context, id string) (*AccountConfig, error) {
	if c.ttl > 0 {
		c.mu.Lock()
		if entry, ok := c.entries[id]; ok && time.Now().Before(entry.expires) {
			c.mu.Unlock()
			return cloneConfig(entry.cfg), nil
		}
		c.mu.Unlock()
	}
	cfg, err := c.inner.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		c.invalidate(id)
		return nil, nil
	}
	c.store(id, cfg)
	return cloneConfig(cfg), nil
}

// List bypasses the cache to keep the durable store authoritative for
// admin views.
func (c *CachedAccountConfigStore) List(ctx context.Context) ([]*AccountConfig, error) {
	return c.inner.List(ctx)
}

// Delete writes through and invalidates the cache.
func (c *CachedAccountConfigStore) Delete(ctx context.Context, id string) error {
	if err := c.inner.Delete(ctx, id); err != nil {
		return err
	}
	c.invalidate(id)
	return nil
}

func (c *CachedAccountConfigStore) store(id string, cfg *AccountConfig) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.max > 0 {
		for len(c.entries) >= c.max {
			// Evict any expired entry first.
			now := time.Now()
			evicted := false
			for k, v := range c.entries {
				if !now.Before(v.expires) {
					delete(c.entries, k)
					evicted = true
					break
				}
			}
			if !evicted {
				// No expired entries; drop an arbitrary one.
				for k := range c.entries {
					delete(c.entries, k)
					break
				}
			}
		}
	}
	c.entries[id] = cachedConfigEntry{cfg: cloneConfig(cfg), expires: time.Now().Add(c.ttl)}
}

func (c *CachedAccountConfigStore) invalidate(id string) {
	c.mu.Lock()
	delete(c.entries, id)
	c.mu.Unlock()
}

func cloneConfig(in *AccountConfig) *AccountConfig {
	if in == nil {
		return nil
	}
	out := *in
	if in.Labels != nil {
		out.Labels = make(map[string]string, len(in.Labels))
		for k, v := range in.Labels {
			out.Labels[k] = v
		}
	}
	if in.Scopes != nil {
		out.Scopes = append([]string(nil), in.Scopes...)
	}
	return &out
}

// sortStrings sorts in place. It exists to keep the in-memory store
// free of the sort package dependency; the slice is small.
func sortStrings(xs []string) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j-1] > xs[j]; j-- {
			xs[j-1], xs[j] = xs[j], xs[j-1]
		}
	}
}
