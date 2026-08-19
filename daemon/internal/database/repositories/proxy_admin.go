package repositories

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/server/admin"
	"github.com/uptrace/bun"
)

// BunProxyAdminRepository is the PostgreSQL implementation of
// admin.ProxyAdminService. It exposes a narrow CRUD surface for the operator
// dashboard; the proxy pipeline keeps its own richer view via
// BunProxyRepository.
type BunProxyAdminRepository struct {
	db *bun.DB
}

// NewBunProxyAdminRepository constructs a Bun-backed admin proxy repository.
// A nil db is preserved so ready() reports ErrRepositoryClosed consistently
// with the rest of this package.
func NewBunProxyAdminRepository(db *bun.DB) *BunProxyAdminRepository {
	if db == nil {
		return &BunProxyAdminRepository{}
	}
	return &BunProxyAdminRepository{db: db}
}

func (r *BunProxyAdminRepository) ready() error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	return nil
}

// proxyAdminRow is the on-disk projection of the proxies table that backs
// admin.ProxyRecord. It intentionally omits fields the dashboard does not
// expose (credentials, cooldown, last-test telemetry).
type proxyAdminRow struct {
	bun.BaseModel  `bun:"table:proxies"`
	ID             string    `bun:"id"`
	Type           string    `bun:"protocol"`
	Host           string    `bun:"host"`
	Port           int       `bun:"port"`
	Priority       int       `bun:"priority"`
	Weight         int       `bun:"weight"`
	MaxConcurrency int       `bun:"max_concurrency"`
	Active         bool      `bun:"active"`
	CreatedAt      time.Time `bun:"created_at"`
	UpdatedAt      time.Time `bun:"updated_at"`
}

// proxyAdminHealthRow is the optional sidecar joined to enrich a proxy
// listing with its current health status.
type proxyAdminHealthRow struct {
	bun.BaseModel `bun:"table:proxy_health"`
	ProxyID       string `bun:"proxy_id"`
	Status        string `bun:"status"`
}

// proxyAdminRecord maps a joined row+health pair to the operator-safe record.
// health defaults to "unknown" when the sidecar is absent so callers always
// receive a stable value.
func proxyAdminRecord(row proxyAdminRow, health string) admin.ProxyRecord {
	return admin.ProxyRecord{
		ID:             row.ID,
		Type:           row.Type,
		Host:           row.Host,
		Port:           row.Port,
		Priority:       row.Priority,
		Weight:         row.Weight,
		MaxConcurrency: row.MaxConcurrency,
		Active:         row.Active,
		Health:         health,
		CreatedAt:      row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:      row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// List returns every proxy joined with its health sidecar (or "unknown"
// when absent). An empty slice is returned when the table is empty so the
// dashboard can iterate unconditionally.
func (r *BunProxyAdminRepository) List(ctx context.Context) ([]admin.ProxyRecord, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	rows := []proxyAdminRow{}
	if err := r.db.NewSelect().
		Model(&rows).
		OrderExpr("priority ASC, id ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("proxy admin: list: %w", err)
	}
	if len(rows) == 0 {
		return []admin.ProxyRecord{}, nil
	}

	healthRows := []proxyAdminHealthRow{}
	if err := r.db.NewSelect().
		Model(&healthRows).
		Where("proxy_id IN (?)", bun.In(proxyAdminIDs(rows))).
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("proxy admin: list health: %w", err)
	}

	health := make(map[string]string, len(healthRows))
	for _, h := range healthRows {
		health[h.ProxyID] = h.Status
	}

	out := make([]admin.ProxyRecord, len(rows))
	for i, row := range rows {
		status, ok := health[row.ID]
		if !ok {
			status = "unknown"
		}
		out[i] = proxyAdminRecord(row, status)
	}
	return out, nil
}

// proxyAdminIDs extracts the proxy id slice for an IN-clause.
func proxyAdminIDs(rows []proxyAdminRow) []string {
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

// Create inserts a new proxy and returns the persisted record joined with
// its (absent) health status.
func (r *BunProxyAdminRepository) Create(ctx context.Context, input admin.ProxyInput) (admin.ProxyRecord, error) {
	if err := r.ready(); err != nil {
		return admin.ProxyRecord{}, err
	}
	if err := proxyAdminValidateInput(input, true); err != nil {
		return admin.ProxyRecord{}, err
	}

	id, err := proxyAdminNewID()
	if err != nil {
		return admin.ProxyRecord{}, fmt.Errorf("proxy admin: create id: %w", err)
	}
	now := time.Now().UTC()
	kind := strings.TrimSpace(*input.Type)
	host := strings.TrimSpace(*input.Host)
	port := *input.Port

	priority := 100
	if input.Priority != nil {
		priority = *input.Priority
	}
	weight := 100
	if input.Weight != nil {
		weight = *input.Weight
	}
	maxConcurrency := 8
	if input.MaxConcurrency != nil {
		maxConcurrency = *input.MaxConcurrency
	}
	active := true
	if input.Active != nil {
		active = *input.Active
	}

	if _, err := r.db.NewRaw(
		`INSERT INTO proxies (id, name, protocol, is_relay, host, port, priority, weight, max_concurrency, active, created_at, updated_at) VALUES (?, ?, ?, FALSE, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, id, kind, host, port, priority, weight, maxConcurrency, active, now, now,
	).Exec(ctx); err != nil {
		return admin.ProxyRecord{}, fmt.Errorf("proxy admin: create: %w", err)
	}
	return proxyAdminLoad(ctx, r.db, id, "unknown")
}

// Update applies a partial mutation to an existing proxy and returns the
// refreshed record. sql.ErrNoRows is returned when the id is unknown so the
// handler can surface a 404.
func (r *BunProxyAdminRepository) Update(ctx context.Context, id string, input admin.ProxyInput) (admin.ProxyRecord, error) {
	if err := r.ready(); err != nil {
		return admin.ProxyRecord{}, err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return admin.ProxyRecord{}, errors.New("proxy admin: id is required")
	}
	if err := proxyAdminValidateInput(input, false); err != nil {
		return admin.ProxyRecord{}, err
	}

	fields := []string{}
	args := []any{}
	add := func(col string, v any) {
		fields = append(fields, col+" = ?")
		args = append(args, v)
	}
	if input.Type != nil {
		add("protocol", strings.TrimSpace(*input.Type))
	}
	if input.Host != nil {
		add("host", strings.TrimSpace(*input.Host))
	}
	if input.Port != nil {
		add("port", *input.Port)
	}
	if input.Priority != nil {
		add("priority", *input.Priority)
	}
	if input.Weight != nil {
		add("weight", *input.Weight)
	}
	if input.MaxConcurrency != nil {
		add("max_concurrency", *input.MaxConcurrency)
	}
	if input.Active != nil {
		add("active", *input.Active)
	}

	if len(fields) == 0 {
		return proxyAdminLoad(ctx, r.db, id, "")
	}
	fields = append(fields, "updated_at = ?")
	args = append(args, time.Now().UTC())
	args = append(args, id)

	res, err := r.db.NewRaw(
		"UPDATE proxies SET "+strings.Join(fields, ", ")+" WHERE id = ?",
		args...,
	).Exec(ctx)
	if err != nil {
		return admin.ProxyRecord{}, fmt.Errorf("proxy admin: update: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return admin.ProxyRecord{}, sql.ErrNoRows
	}
	return proxyAdminLoad(ctx, r.db, id, "")
}

// Delete removes a proxy by id. sql.ErrNoRows is returned when no row was
// affected so callers can distinguish "not found" from infrastructure errors.
func (r *BunProxyAdminRepository) Delete(ctx context.Context, id string) error {
	if err := r.ready(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("proxy admin: id is required")
	}
	res, err := r.db.NewRaw(`DELETE FROM proxies WHERE id = ?`, id).Exec(ctx)
	if err != nil {
		return fmt.Errorf("proxy admin: delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// proxyAdminLoad fetches a single proxy joined with its health sidecar and
// projects it into the operator-safe record. Empty fallbackHealth means the
// health lookup is required (errors propagate).
func proxyAdminLoad(ctx context.Context, db *bun.DB, id, fallbackHealth string) (admin.ProxyRecord, error) {
	var row proxyAdminRow
	if err := db.NewSelect().Model(&row).Where("id = ?", id).Scan(ctx); err != nil {
		return admin.ProxyRecord{}, err
	}
	health := fallbackHealth
	if health == "" {
		var h proxyAdminHealthRow
		if err := db.NewSelect().Model(&h).Where("proxy_id = ?", id).Scan(ctx); err == nil {
			health = h.Status
		} else if !errors.Is(err, sql.ErrNoRows) {
			return admin.ProxyRecord{}, fmt.Errorf("proxy admin: load health: %w", err)
		} else {
			health = "unknown"
		}
	}
	return proxyAdminRecord(row, health), nil
}

// proxyAdminValidateInput enforces the contract shared by Create and
// Update. requireAll=true forces Type/Host/Port to be present (Create);
// requireAll=false only bounds them when supplied (Update).
func proxyAdminValidateInput(input admin.ProxyInput, requireAll bool) error {
	if requireAll {
		if input.Type == nil || input.Host == nil || input.Port == nil {
			return errors.New("proxy admin: type, host, and port are required")
		}
	} else if input.Type == nil && input.Host == nil && input.Port == nil &&
		input.Priority == nil && input.Weight == nil && input.MaxConcurrency == nil && input.Active == nil {
		return errors.New("proxy admin: no fields supplied")
	}
	if input.Type != nil {
		t := strings.TrimSpace(*input.Type)
		if t == "" {
			return errors.New("proxy admin: type is required")
		}
		if t != "http" && t != "https" && t != "socks5" {
			return fmt.Errorf("proxy admin: unsupported type %q", t)
		}
	}
	if input.Host != nil {
		h := strings.TrimSpace(*input.Host)
		if h == "" || len(h) > 512 {
			return errors.New("proxy admin: host is required and bounded")
		}
	}
	if input.Port != nil {
		if *input.Port < 1 || *input.Port > 65535 {
			return errors.New("proxy admin: port must be between 1 and 65535")
		}
	}
	if input.Priority != nil {
		if *input.Priority < -100000 || *input.Priority > 100000 {
			return errors.New("proxy admin: priority is out of bounds")
		}
	}
	if input.Weight != nil {
		if *input.Weight < 1 || *input.Weight > 1000 {
			return errors.New("proxy admin: weight is out of bounds")
		}
	}
	if input.MaxConcurrency != nil {
		if *input.MaxConcurrency < 1 || *input.MaxConcurrency > 10000 {
			return errors.New("proxy admin: max concurrency is out of bounds")
		}
	}
	return nil
}

// proxyAdminNewID returns a 16-byte hex id; collision odds are negligible at
// the operational scale of this surface.
func proxyAdminNewID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// Compile-time assertion that BunProxyAdminRepository satisfies the admin
// contract. A drift in either side surfaces here at build time.
var _ admin.ProxyAdminService = (*BunProxyAdminRepository)(nil)
