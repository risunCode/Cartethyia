package cache

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	redis "github.com/redis/go-redis/v9"
)

// NewRedisClient creates a concrete Redis-compatible client from a redis:// or
// rediss:// URL. Configuration errors are returned eagerly; connectivity is
// checked by RedisBackend.Probe so Redis remains an optional cache dependency.
func NewRedisClient(rawURL string, commandTimeout time.Duration) (RemoteClient, error) {
	if strings.TrimSpace(rawURL) == "" {
		return nil, errors.New("redis: URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("redis: parse URL: %w", err)
	}
	if parsed.Scheme != "redis" && parsed.Scheme != "rediss" {
		return nil, fmt.Errorf("redis: unsupported URL scheme %q (want redis or rediss)", parsed.Scheme)
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return nil, errors.New("redis: URL must include a host")
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("redis: unsupported URL: %w", err)
	}
	if options.Addr == "" {
		return nil, errors.New("redis: URL must include a host")
	}
	if commandTimeout > 0 {
		options.DialTimeout = commandTimeout
		options.ReadTimeout = commandTimeout
		options.WriteTimeout = commandTimeout
	}
	return &goRedisClient{client: redis.NewClient(options)}, nil
}

// ParseRedisURL validates a configured URL without opening a network
// connection. It is useful at config/bootstrap boundaries.
func ParseRedisURL(rawURL string) error {
	_, err := NewRedisClient(rawURL, 0)
	if err == nil {
		return nil
	}
	return err
}

type goRedisClient struct{ client *redis.Client }

func (c *goRedisClient) Get(ctx context.Context, key string) ([]byte, error) {
	value, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrRemoteMiss
	}
	return value, err
}

func (c *goRedisClient) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return c.client.Set(ctx, key, value, ttl).Err()
}

func (c *goRedisClient) Delete(ctx context.Context, key string) error {
	return c.client.Del(ctx, key).Err()
}

func (c *goRedisClient) Ping(ctx context.Context) error { return c.client.Ping(ctx).Err() }

func (c *goRedisClient) Close() error { return c.client.Close() }

var _ RemoteClient = (*goRedisClient)(nil)
