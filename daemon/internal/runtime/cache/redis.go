package cache

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrRemoteMiss is the miss sentinel understood by RemoteClient.Get. A
// go-redis adapter can translate redis.Nil to this value at its boundary.
// RedisBackend never requires a concrete Redis client dependency.
var ErrRemoteMiss = errors.New("cache: remote miss")

// RemoteClient is the deliberately narrow command boundary used by
// RedisBackend. An adapter around github.com/redis/go-redis/v9 (or another
// Redis-compatible client) can implement these methods without leaking that
// dependency into request-path packages. Get returns ErrRemoteMiss when the
// key does not exist.
type RemoteClient interface {
	Get(context.Context, string) ([]byte, error)
	Set(context.Context, string, []byte, time.Duration) error
	Delete(context.Context, string) error
	Ping(context.Context) error
	Close() error
}

// RedisClient is a descriptive alias for callers that inject a
// Redis-compatible command client.
type RedisClient = RemoteClient

// RedisConfig controls the wire namespace and per-command deadline. A zero
// CommandTimeout leaves timeout enforcement to the caller's context. Clock is
// used only for deterministic tests and expiry accounting.
type RedisConfig struct {
	Prefix         string
	CommandTimeout time.Duration
	Clock          func() time.Time
}

// RedisBackend stores generation-aware cache entries through RemoteClient.
// It starts unhealthy until the first successful probe, transitions offline
// on Close, and never treats malformed remote data as a hit.
type RedisBackend struct {
	client  RemoteClient
	prefix  string
	timeout time.Duration
	clock   func() time.Time

	mu          sync.Mutex
	closed      bool
	state       HealthState
	lastChecked time.Time
	lastError   error
	hits        uint64
	misses      uint64
}

// NewRedisBackend constructs an optional remote backend. A nil client is a
// configuration error; an absent Redis deployment should instead be
// represented by passing nil as Router's primary backend.
func NewRedisBackend(client RemoteClient, cfg RedisConfig) (*RedisBackend, error) {
	if client == nil {
		return nil, cacheError(ErrRemoteNotConfigured, "construct", nil)
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	prefix := cfg.Prefix
	if prefix == "" {
		prefix = "cartethyia:resolution:v1:"
	}
	return &RedisBackend{
		client:  client,
		prefix:  prefix,
		timeout: cfg.CommandTimeout,
		clock:   cfg.Clock,
		state:   HealthUnhealthy,
	}, nil
}

// NewRemoteBackend is an explicit synonym for NewRedisBackend at the
// RemoteBackend boundary. It avoids tying callers to a concrete client type.
func NewRemoteBackend(client RemoteClient, cfg RedisConfig) (*RedisBackend, error) {
	return NewRedisBackend(client, cfg)
}

func (r *RedisBackend) commandContext(ctx context.Context) (context.Context, context.CancelFunc, error) {
	if ctx == nil {
		return nil, nil, cacheError(ErrRemoteCommand, "context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if r.timeout <= 0 {
		return ctx, func() {}, nil
	}
	commandCtx, cancel := context.WithTimeout(ctx, r.timeout)
	return commandCtx, cancel, nil
}

func (r *RedisBackend) run(ctx context.Context, op string, fn func(context.Context) error) error {
	if r == nil {
		return cacheError(ErrRemoteNotConfigured, op, nil)
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrClosed
	}
	client := r.client
	r.mu.Unlock()
	if client == nil {
		return cacheError(ErrRemoteNotConfigured, op, nil)
	}

	commandCtx, cancel, err := r.commandContext(ctx)
	if err != nil {
		return err
	}
	defer cancel()
	err = fn(commandCtx)
	if err == nil {
		r.markSuccess()
		return nil
	}
	// A miss is a valid cache outcome, not a remote-health failure.
	if errors.Is(err, ErrMiss) {
		return err
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
		err = cacheError(ErrRemoteTimeout, op, err)
	} else {
		err = cacheError(ErrRemoteCommand, op, err)
	}
	r.markFailure(err)
	return err
}

func (r *RedisBackend) markSuccess() {
	r.mu.Lock()
	if !r.closed {
		r.state = HealthOnline
		r.lastChecked = r.clock()
		r.lastError = nil
	}
	r.mu.Unlock()
}
func (r *RedisBackend) markFailure(err error) {
	if err == nil {
		return
	}
	r.mu.Lock()
	if !r.closed {
		r.state = HealthUnhealthy
		r.lastChecked = r.clock()
		r.lastError = err
	}
	r.mu.Unlock()
}

// Probe executes PING and updates health. Caller cancellation is returned
// without changing state; a backend-imposed timeout marks the backend
// unhealthy so the router can use its fallback.
func (r *RedisBackend) Probe(ctx context.Context) error {
	if r == nil {
		return cacheError(ErrRemoteNotConfigured, "probe", nil)
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrClosed
	}
	client := r.client
	r.mu.Unlock()
	if client == nil {
		return cacheError(ErrRemoteNotConfigured, "probe", nil)
	}
	commandCtx, cancel, err := r.commandContext(ctx)
	if err != nil {
		return err
	}
	defer cancel()
	if err = client.Ping(commandCtx); err != nil {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
			err = cacheError(ErrRemoteTimeout, "probe", err)
		} else {
			err = cacheError(ErrRemoteProbe, "probe", err)
		}
		r.markFailure(err)
		return err
	}
	r.markSuccess()
	return nil
}

func (r *RedisBackend) wireKey(key Key) string {
	return r.prefix + key.Wire()
}

type redisRecord struct {
	Key        Key        `json:"key"`
	Value      []byte     `json:"value"`
	StoredAt   time.Time  `json:"stored_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	Generation Generation `json:"generation"`
}

func (r *RedisBackend) decode(key Key, payload []byte) (Entry, error) {
	var record redisRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return Entry{}, cacheError(ErrRemoteSerialization, "decode", err)
	}
	if err := record.Key.validate(); err != nil {
		return Entry{}, cacheError(ErrRemoteSerialization, "decode key", err)
	}
	// A digest key alone is not enough to establish semantic equivalence:
	// verify the complete stored key and generation as well.
	if record.Key.Wire() != key.Wire() {
		return Entry{}, cacheError(ErrRemoteSerialization, "key mismatch", errors.New("stored key does not match lookup key"))
	}
	if !record.Generation.Equal(record.Key.Generation) {
		return Entry{}, cacheError(ErrRemoteSerialization, "generation mismatch in record", errors.New("stored generation disagrees with key"))
	}
	now := r.clock()
	if record.ExpiresAt.IsZero() || !record.ExpiresAt.After(now) {
		r.mu.Lock()
		r.misses++
		r.mu.Unlock()
		return Entry{}, &MissError{Key: key, Reason: "expired"}
	}
	if !record.Generation.Equal(key.Generation) {
		r.mu.Lock()
		r.misses++
		r.mu.Unlock()
		return Entry{}, &GenerationMismatchError{Key: key, Stored: record.Generation, Requested: key.Generation}
	}
	r.mu.Lock()
	r.hits++
	r.mu.Unlock()
	return Entry{
		Key:        record.Key,
		Value:      append([]byte(nil), record.Value...),
		StoredAt:   record.StoredAt,
		ExpiresAt:  record.ExpiresAt,
		Generation: record.Generation,
		Remaining:  record.ExpiresAt.Sub(now),
	}, nil
}

// Get implements Cache.Get using a defensive decode/copy boundary.
func (r *RedisBackend) Get(ctx context.Context, key Key) (Entry, error) {
	if ctx == nil {
		return Entry{}, cacheError(ErrRemoteCommand, "get context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	if err := key.validate(); err != nil {
		return Entry{}, err
	}
	var payload []byte
	err := r.run(ctx, "get", func(commandCtx context.Context) error {
		r.mu.Lock()
		client := r.client
		r.mu.Unlock()
		var getErr error
		payload, getErr = client.Get(commandCtx, r.wireKey(key))
		if errors.Is(getErr, ErrRemoteMiss) {
			return &MissError{Key: key}
		}
		return getErr
	})
	if err != nil {
		if errors.Is(err, ErrMiss) {
			r.mu.Lock()
			r.misses++
			r.mu.Unlock()
		}
		return Entry{}, err
	}
	entry, err := r.decode(key, payload)
	if err != nil && !errors.Is(err, ErrMiss) && !errors.Is(err, ErrGenerationMismatch) {
		r.markFailure(err)
	}
	return entry, err
}

// Set implements Cache.Set with canonical JSON serialization and TTL.
func (r *RedisBackend) Set(ctx context.Context, key Key, value []byte, ttl time.Duration) error {
	if ctx == nil {
		return cacheError(ErrRemoteCommand, "set context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := key.validate(); err != nil {
		return err
	}
	if ttl <= 0 {
		return ErrInvalidTTL
	}
	if r == nil {
		return cacheError(ErrRemoteNotConfigured, "set", nil)
	}
	now := r.clock()
	record := redisRecord{
		Key:        key,
		Value:      append([]byte(nil), value...),
		StoredAt:   now,
		ExpiresAt:  now.Add(ttl),
		Generation: key.Generation,
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return cacheError(ErrRemoteSerialization, "encode", err)
	}
	return r.run(ctx, "set", func(commandCtx context.Context) error {
		r.mu.Lock()
		client := r.client
		r.mu.Unlock()
		return client.Set(commandCtx, r.wireKey(key), payload, ttl)
	})
}

// Delete implements Cache.Delete. Missing keys are a successful no-op.
func (r *RedisBackend) Delete(ctx context.Context, key Key) error {
	if ctx == nil {
		return cacheError(ErrRemoteCommand, "delete context", errors.New("nil context"))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := key.validate(); err != nil {
		return err
	}
	return r.run(ctx, "delete", func(commandCtx context.Context) error {
		r.mu.Lock()
		client := r.client
		r.mu.Unlock()
		return client.Delete(commandCtx, r.wireKey(key))
	})
}

// Health implements Cache.Health without I/O.
func (r *RedisBackend) Health(_ context.Context) Health {
	if r == nil {
		return Health{State: HealthOffline, LastError: cacheError(ErrRemoteNotConfigured, "health", nil)}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.state
	if r.closed {
		state = HealthOffline
	}
	return Health{
		State:       state,
		LastChecked: r.lastChecked,
		LastError:   r.lastError,
		Hits:        r.hits,
		Misses:      r.misses,
	}
}

// Close closes the injected client exactly once. A close error is preserved
// with a stable cache code while subsequent operations return ErrClosed.
func (r *RedisBackend) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	client := r.client
	r.state = HealthOffline
	r.lastChecked = r.clock()
	r.mu.Unlock()
	if client == nil {
		return nil
	}
	if err := client.Close(); err != nil {
		wrapped := cacheError(ErrRemoteCommand, "close", err)
		r.mu.Lock()
		r.lastError = wrapped
		r.mu.Unlock()
		return wrapped
	}
	return nil
}

var _ RemoteBackend = (*RedisBackend)(nil)
var _ Cache = (*RedisBackend)(nil)
