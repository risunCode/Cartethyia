package app

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenAddress       = ":12800"
	defaultEnvironment         = "development"
	defaultRequestTimeout      = 2 * time.Minute
	defaultReadHeaderTimeout   = 10 * time.Second
	defaultConnectTimeout      = 10 * time.Second
	defaultFirstByteTimeout    = 30 * time.Second
	defaultIdleTimeout         = 60 * time.Second
	defaultShutdownTimeout     = 10 * time.Second
	defaultMaxHeaderBytes      = 1 << 20
	defaultUsageRetention      = 30 * 24 * time.Hour
	defaultMaxBodyBytes        = 16 * 1024 * 1024
	defaultMaxOutputTokens     = 1 << 20
	defaultMaxConcurrent       = 256
	defaultMaxConcurrentStream = 256
)

const (
	maxDuration     = 24 * time.Hour
	maxRetention    = 365 * 24 * time.Hour
	maxConcurrent   = 100_000
	maxBodyBytes    = 64 * 1024 * 1024
	maxOutputTokens = 1 << 24
	minHeaderBytes  = 64 * 1024
	maxHeaderBytes  = 2 * 1024 * 1024
)

// Config is the validated process-level configuration.
type Config struct {
	ListenAddress        string
	DashboardDir         string
	DatabaseURL          string
	RedisURL             string
	AccountEncryptionKey string
	Environment          string
	ConsolePassword      string

	// TrustProxy allows client-identity consumers (login rate limiter,
	// analytics) to honor X-Forwarded-For. It must only be enabled when a
	// trusted reverse proxy is the sole direct client of the daemon;
	// otherwise attackers rotate the header to evade or weaponize
	// per-IP limits. Defaults to false.
	TrustProxy bool

	RequestTimeout      time.Duration
	ReadHeaderTimeout   time.Duration
	ConnectTimeout      time.Duration
	FirstByteTimeout    time.Duration
	IdleTimeout         time.Duration
	StreamIdleTimeout   time.Duration
	StreamTotalTimeout  time.Duration
	ShutdownTimeout     time.Duration
	UsageRetention      time.Duration
	MaxBodyBytes        int
	MaxHeaderBytes      int
	MaxOutputTokens     int
	MaxConcurrent       int
	MaxConcurrentStream int
}

// FromEnvironment loads configuration and applies safe defaults. Invalid
// values are returned as errors before runtime construction can begin.
func FromEnvironment() (Config, error) {
	cfg := Config{
		ListenAddress:        firstNonEmpty("CARTETHYIA_LISTEN_ADDRESS", "LISTEN_ADDRESS", defaultListenAddress),
		DashboardDir:         firstNonEmpty("CARTETHYIA_DASHBOARD_DIR", "dashboard/dist"),
		DatabaseURL:          firstNonEmpty("CARTETHYIA_DATABASE_URL", "DATABASE_URL", ""),
		RedisURL:             firstNonEmpty("CARTETHYIA_REDIS_URL", "REDIS_URL", ""),
		AccountEncryptionKey: firstNonEmpty("CARTETHYIA_ENCRYPTION_KEY", "CARTETHYIA_ACCOUNT_ENCRYPTION_KEY", "ACCOUNT_ENCRYPTION_KEY", ""),
		Environment:          firstNonEmpty("CARTETHYIA_ENV", "NODE_ENV", defaultEnvironment),
		ConsolePassword:      firstNonEmpty("CONSOLE_PASSWORD", ""),
		RequestTimeout:       defaultRequestTimeout,
		ReadHeaderTimeout:    defaultReadHeaderTimeout,
		ConnectTimeout:       defaultConnectTimeout,
		FirstByteTimeout:     defaultFirstByteTimeout,
		IdleTimeout:          defaultIdleTimeout,
		StreamIdleTimeout:    defaultIdleTimeout,
		StreamTotalTimeout:   defaultRequestTimeout,
		ShutdownTimeout:      defaultShutdownTimeout,
		UsageRetention:       defaultUsageRetention,
		MaxBodyBytes:         defaultMaxBodyBytes,
		MaxHeaderBytes:       defaultMaxHeaderBytes,
		MaxOutputTokens:      defaultMaxOutputTokens,
		MaxConcurrent:        defaultMaxConcurrent,
		MaxConcurrentStream:  defaultMaxConcurrentStream,
	}

	var err error
	if cfg.TrustProxy, err = boolEnv("CARTETHYIA_TRUST_PROXY", false); err != nil {
		return Config{}, err
	}
	if cfg.RequestTimeout, err = durationEnv("CARTETHYIA_REQUEST_TIMEOUT", cfg.RequestTimeout); err != nil {
		return Config{}, err
	}
	readHeaderFallback := defaultReadHeaderTimeout
	if readHeaderFallback > cfg.RequestTimeout {
		readHeaderFallback = cfg.RequestTimeout
	}
	if cfg.ReadHeaderTimeout, err = durationEnv("CARTETHYIA_READ_HEADER_TIMEOUT", readHeaderFallback); err != nil {
		return Config{}, err
	}
	if cfg.ConnectTimeout, err = durationEnv("CARTETHYIA_CONNECT_TIMEOUT", cfg.ConnectTimeout); err != nil {
		return Config{}, err
	}
	if cfg.FirstByteTimeout, err = durationEnv("CARTETHYIA_FIRST_BYTE_TIMEOUT", cfg.FirstByteTimeout); err != nil {
		return Config{}, err
	}
	if cfg.IdleTimeout, err = durationEnv("CARTETHYIA_IDLE_TIMEOUT", cfg.IdleTimeout); err != nil {
		return Config{}, err
	}
	if cfg.StreamIdleTimeout, err = durationEnv("CARTETHYIA_STREAM_IDLE_TIMEOUT", cfg.IdleTimeout); err != nil {
		return Config{}, err
	}
	if cfg.StreamTotalTimeout, err = durationEnv("CARTETHYIA_STREAM_TOTAL_TIMEOUT", cfg.RequestTimeout); err != nil {
		return Config{}, err
	}
	if cfg.ShutdownTimeout, err = durationEnv("CARTETHYIA_SHUTDOWN_TIMEOUT", cfg.ShutdownTimeout); err != nil {
		return Config{}, err
	}
	if cfg.UsageRetention, err = durationEnv("CARTETHYIA_USAGE_RETENTION", cfg.UsageRetention); err != nil {
		return Config{}, err
	}
	if cfg.MaxBodyBytes, err = intEnv("CARTETHYIA_MAX_BODY_BYTES", cfg.MaxBodyBytes); err != nil {
		return Config{}, err
	}
	if cfg.MaxHeaderBytes, err = intEnv("CARTETHYIA_MAX_HEADER_BYTES", cfg.MaxHeaderBytes); err != nil {
		return Config{}, err
	}
	if cfg.MaxOutputTokens, err = intEnv("CARTETHYIA_MAX_OUTPUT_TOKENS", cfg.MaxOutputTokens); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrent, err = intEnv("CARTETHYIA_MAX_CONCURRENT", cfg.MaxConcurrent); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrentStream, err = intEnv("CARTETHYIA_MAX_CONCURRENT_STREAMS", cfg.MaxConcurrentStream); err != nil {
		return Config{}, err
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// WithDefaults fills only zero-valued optional settings. Explicit invalid
// values remain untouched so validation still rejects them.
func (c Config) WithDefaults() Config {
	if c.ListenAddress == "" {
		c.ListenAddress = defaultListenAddress
	}
	if c.Environment == "" {
		c.Environment = defaultEnvironment
	}
	if c.RequestTimeout == 0 {
		c.RequestTimeout = defaultRequestTimeout
	}
	if c.ReadHeaderTimeout == 0 {
		c.ReadHeaderTimeout = defaultReadHeaderTimeout
		if c.ReadHeaderTimeout > c.RequestTimeout {
			c.ReadHeaderTimeout = c.RequestTimeout
		}
	}
	if c.ConnectTimeout == 0 {
		c.ConnectTimeout = defaultConnectTimeout
	}
	if c.FirstByteTimeout == 0 {
		c.FirstByteTimeout = defaultFirstByteTimeout
	}
	if c.IdleTimeout == 0 {
		c.IdleTimeout = defaultIdleTimeout
	}
	if c.StreamIdleTimeout == 0 {
		c.StreamIdleTimeout = c.IdleTimeout
	}
	if c.StreamTotalTimeout == 0 {
		c.StreamTotalTimeout = c.RequestTimeout
	}
	if c.ShutdownTimeout == 0 {
		c.ShutdownTimeout = defaultShutdownTimeout
	}
	if c.UsageRetention == 0 {
		c.UsageRetention = defaultUsageRetention
	}
	if c.MaxBodyBytes == 0 {
		c.MaxBodyBytes = defaultMaxBodyBytes
	}
	if c.MaxHeaderBytes == 0 {
		c.MaxHeaderBytes = defaultMaxHeaderBytes
	}
	if c.MaxOutputTokens == 0 {
		c.MaxOutputTokens = defaultMaxOutputTokens
	}
	if c.MaxConcurrent == 0 {
		c.MaxConcurrent = defaultMaxConcurrent
	}
	if c.MaxConcurrentStream == 0 {
		c.MaxConcurrentStream = defaultMaxConcurrentStream
	}
	return c
}

// Validate checks configuration without opening any dependency or listener.
func (c Config) Validate() error {
	if err := validateListenAddress(c.ListenAddress); err != nil {
		return err
	}
	if strings.TrimSpace(c.Environment) == "" || len(c.Environment) > 64 {
		return errors.New("environment must be non-empty and bounded")
	}
	if err := validateOptionalURL(c.DatabaseURL, "postgres", "postgresql"); err != nil {
		return fmt.Errorf("database configuration: %w", err)
	}
	if err := validateOptionalURL(c.RedisURL, "redis", "rediss"); err != nil {
		return fmt.Errorf("redis configuration: %w", err)
	}
	for name, value := range map[string]time.Duration{
		"request timeout":      c.RequestTimeout,
		"read header timeout":  c.ReadHeaderTimeout,
		"connect timeout":      c.ConnectTimeout,
		"first byte timeout":   c.FirstByteTimeout,
		"idle timeout":         c.IdleTimeout,
		"stream idle timeout":  c.StreamIdleTimeout,
		"stream total timeout": c.StreamTotalTimeout,
		"shutdown timeout":     c.ShutdownTimeout,
	} {
		if value <= 0 || value > maxDuration {
			return fmt.Errorf("%s must be between 1ns and 24h", name)
		}
	}
	if c.ReadHeaderTimeout > c.RequestTimeout {
		return errors.New("read header timeout must not exceed request timeout")
	}
	if c.UsageRetention <= 0 || c.UsageRetention > maxRetention {
		return errors.New("usage retention must be between 1ns and 365d")
	}
	if c.MaxBodyBytes <= 0 || c.MaxBodyBytes > maxBodyBytes {
		return errors.New("max body bytes is outside the safe range")
	}
	if c.MaxHeaderBytes < minHeaderBytes || c.MaxHeaderBytes > maxHeaderBytes {
		return errors.New("max header bytes is outside the safe range")
	}
	if c.MaxOutputTokens <= 0 || c.MaxOutputTokens > maxOutputTokens {
		return errors.New("max output tokens is outside the safe range")
	}
	if c.MaxConcurrent <= 0 || c.MaxConcurrent > maxConcurrent {
		return errors.New("max concurrent requests is outside the safe range")
	}
	if c.MaxConcurrentStream <= 0 || c.MaxConcurrentStream > maxConcurrent {
		return errors.New("max concurrent streams is outside the safe range")
	}
	return nil
}

func firstNonEmpty(names ...string) string {
	for _, name := range names[:len(names)-1] {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return names[len(names)-1]
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a valid duration", name)
	}
	return value, nil
}

func intEnv(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return value, nil
}

func boolEnv(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a valid boolean", name)
	}
	return value, nil
}

// TrustProxyFromEnvironment reports whether forwarding headers may be
// trusted for client-identity resolution. It exists for HTTP boundary
// layers that resolve client identity per request and are wired without a
// Config handle (the admin login limiter). Malformed values fail closed to
// false; the parse semantics match the CARTETHYIA_TRUST_PROXY entry in
// FromEnvironment.
func TrustProxyFromEnvironment() bool {
	trusted, err := boolEnv("CARTETHYIA_TRUST_PROXY", false)
	return err == nil && trusted
}

func validateListenAddress(address string) error {
	address = strings.TrimSpace(address)
	if address == "" {
		return errors.New("listen address must not be empty")
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("listen address must use host:port form")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 {
		return errors.New("listen address port is invalid")
	}
	return nil
}

func validateOptionalURL(raw string, schemes ...string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("URL is malformed")
	}
	for _, scheme := range schemes {
		if u.Scheme == scheme {
			return nil
		}
	}
	return errors.New("URL scheme is unsupported")
}
