package db

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Config is the parsed PostgreSQL connection configuration.
//
// Fields are populated from a libpq-style URL via ParseConfig; the URL is
// the only portable way to thread the daemon's DatabaseURL setting through
// the runtime without coupling this package to a driver.
type Config struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
	SSLMode  string

	// MaxOpenConns is the upper bound on concurrently open connections.
	MaxOpenConns int
	// MaxIdleConns is the connection pool idle cap.
	MaxIdleConns int
}

// ParseConfig extracts a Config from a libpq URL (postgresql://…).
func ParseConfig(rawURL string) (Config, error) {
	if strings.TrimSpace(rawURL) == "" {
		return Config{}, errors.New("empty database URL")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return Config{}, fmt.Errorf("parse database URL: %w", err)
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return Config{}, fmt.Errorf("unsupported database scheme %q", u.Scheme)
	}
	cfg := Config{
		Host:         u.Hostname(),
		SSLMode:      "prefer",
		MaxOpenConns: 16,
		MaxIdleConns: 4,
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil {
			return Config{}, fmt.Errorf("invalid port: %w", err)
		}
		cfg.Port = n
	} else {
		cfg.Port = 5432
	}
	if u.User != nil {
		cfg.User = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			cfg.Password = pw
		}
	}
	cfg.Database = strings.TrimPrefix(u.Path, "/")
	if ssl, ok := u.Query()["sslmode"]; ok && len(ssl) > 0 {
		cfg.SSLMode = ssl[0]
	}
	if pool, ok := u.Query()["max_open_conns"]; ok && len(pool) > 0 {
		if n, err := strconv.Atoi(pool[0]); err == nil && n > 0 {
			cfg.MaxOpenConns = n
		}
	}
	if pool, ok := u.Query()["max_idle_conns"]; ok && len(pool) > 0 {
		if n, err := strconv.Atoi(pool[0]); err == nil && n > 0 {
			cfg.MaxIdleConns = n
		}
	}
	return cfg, nil
}

// DSN returns a libpq-style URL suitable for most Go PostgreSQL drivers.
func (c Config) DSN() string {
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.User, c.Password),
		Host:   net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		Path:   "/" + c.Database,
	}
	q := u.Query()
	q.Set("sslmode", c.SSLMode)
	u.RawQuery = q.Encode()
	return u.String()
}
