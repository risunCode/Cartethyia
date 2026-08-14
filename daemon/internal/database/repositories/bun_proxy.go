package repositories

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
)

const (
	maxProxyRows  = 4096
	maxProxyText  = 512
	maxProxyError = 500
)

// BunProxyRepository persists outbound proxy routes, health, settings, and
// the legacy WARP/ custom-provider surfaces on one PostgreSQL handle.
type BunProxyRepository struct {
	db     *bun.DB
	custom *BunCustomProviderRepository
}

func NewBunProxyRepository(db *bun.DB) *BunProxyRepository {
	if db == nil {
		return &BunProxyRepository{}
	}
	return &BunProxyRepository{db: db, custom: NewBunCustomProviderRepository(db)}
}

type proxyRow struct {
	ID                       string     `bun:"id"`
	Name                     string     `bun:"name"`
	Protocol                 string     `bun:"protocol"`
	IsRelay                  bool       `bun:"is_relay"`
	Host                     string     `bun:"host"`
	Port                     int        `bun:"port"`
	Username                 *string    `bun:"username"`
	Password                 *string    `bun:"password"`
	Priority                 int        `bun:"priority"`
	Weight                   int        `bun:"weight"`
	MaxConcurrency           int        `bun:"max_concurrency"`
	Active                   bool       `bun:"active"`
	CreatedAt                time.Time  `bun:"created_at"`
	CooldownUntil            *time.Time `bun:"cooldown_until"`
	CooldownLevel            int        `bun:"cooldown_level"`
	ConsecutiveUseCount      int        `bun:"consecutive_use_count"`
	LastUsedAt               *time.Time `bun:"last_used_at"`
	UpdatedAt                time.Time  `bun:"updated_at"`
	LastTestAt               *time.Time `bun:"last_test_at"`
	LastTestSuccessAt        *time.Time `bun:"last_test_success_at"`
	LastTestSuccessLatencyMs *int       `bun:"last_test_success_latency_ms"`
	LastTestErrorAt          *time.Time `bun:"last_test_error_at"`
	LastTestError            *string    `bun:"last_test_error"`
	LastTestStatusCode       *int       `bun:"last_test_status_code"`
}

func (r proxyRow) model() models.Proxy {
	return models.Proxy{ID: r.ID, Name: r.Name, Protocol: models.ProxyProtocol(r.Protocol), IsRelay: r.IsRelay, Host: r.Host, Port: r.Port,
		Username: valueString(r.Username), Password: valueString(r.Password), Priority: r.Priority, Weight: r.Weight, MaxConcurrency: r.MaxConcurrency,
		Active: r.Active, CreatedAt: r.CreatedAt, CooldownUntil: r.CooldownUntil, CooldownLevel: r.CooldownLevel, ConsecutiveUseCount: r.ConsecutiveUseCount,
		LastUsedAt: r.LastUsedAt, UpdatedAt: r.UpdatedAt, LastTestAt: r.LastTestAt, LastTestSuccessAt: r.LastTestSuccessAt,
		LastTestSuccessLatencyMs: r.LastTestSuccessLatencyMs, LastTestErrorAt: r.LastTestErrorAt, LastTestError: valueString(r.LastTestError), LastTestStatusCode: r.LastTestStatusCode}
}

func (r *BunProxyRepository) ready() error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	return nil
}
func boundProxy(v string) string { return strings.TrimSpace(v) }
func validateProxyInput(v models.ProxyCreateInput) error {
	v.ID = boundProxy(v.ID)
	v.Name = boundProxy(v.Name)
	v.Host = boundProxy(v.Host)
	if v.ID == "" || len(v.ID) > maxProxyText || v.Name == "" || len(v.Name) > maxProxyText || v.Host == "" || len(v.Host) > maxProxyText {
		return errors.New("proxy: id, name, and host are required and bounded")
	}
	if v.Protocol != "http" && v.Protocol != "https" && v.Protocol != "socks5" {
		return fmt.Errorf("proxy: unsupported protocol %q", v.Protocol)
	}
	if v.Port < 1 || v.Port > 65535 {
		return errors.New("proxy: port must be between 1 and 65535")
	}
	if v.MaxConcurrency < 1 || v.MaxConcurrency > 10000 {
		return errors.New("proxy: max concurrency is out of bounds")
	}
	if v.Weight < 1 || v.Weight > 1000 {
		return errors.New("proxy: weight is out of bounds")
	}
	if v.Priority < -100000 || v.Priority > 100000 {
		return errors.New("proxy: priority is out of bounds")
	}
	return nil
}
func (r *BunProxyRepository) load(ctx context.Context, id string) (models.Proxy, error) {
	var row proxyRow
	err := r.db.NewSelect().Model(&row).Table("proxies").Where("id = ?", boundProxy(id)).Scan(ctx)
	if err != nil {
		return models.Proxy{}, err
	}
	return row.model(), nil
}
func (r *BunProxyRepository) List(ctx context.Context) ([]models.Proxy, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	rows := []proxyRow{}
	if err := r.db.NewSelect().Model(&rows).Table("proxies").Order("priority ASC, name ASC, id ASC").Limit(maxProxyRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.Proxy, len(rows))
	for i := range rows {
		out[i] = rows[i].model()
	}
	return out, nil
}
func (r *BunProxyRepository) Get(ctx context.Context, id string) (models.Proxy, error) {
	if err := r.ready(); err != nil {
		return models.Proxy{}, err
	}
	return r.load(ctx, id)
}
func (r *BunProxyRepository) Create(ctx context.Context, in models.ProxyCreateInput) (models.Proxy, error) {
	if err := r.ready(); err != nil {
		return models.Proxy{}, err
	}
	if in.MaxConcurrency == 0 {
		in.MaxConcurrency = 8
	}
	if in.Priority == 0 {
		in.Priority = 100
	}
	if in.Weight == 0 {
		in.Weight = 100
	}
	in.ID = boundProxy(in.ID)
	in.Name = boundProxy(in.Name)
	in.Host = boundProxy(in.Host)
	in.Username = boundProxy(in.Username)
	if err := validateProxyInput(in); err != nil {
		return models.Proxy{}, err
	}
	now := time.Now().UTC()
	_, err := r.db.NewRaw(`INSERT INTO proxies (id,name,protocol,is_relay,host,port,username,password,priority,weight,max_concurrency,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, in.ID, in.Name, string(in.Protocol), in.IsRelay, in.Host, in.Port, nullString(in.Username), nullString(in.Password), in.Priority, in.Weight, in.MaxConcurrency, in.Active, now, now).Exec(ctx)
	if err != nil {
		return models.Proxy{}, err
	}
	return r.load(ctx, in.ID)
}
func nullString(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}
func (r *BunProxyRepository) Patch(ctx context.Context, id string, p models.ProxyPatchInput) (models.Proxy, error) {
	if err := r.ready(); err != nil {
		return models.Proxy{}, err
	}
	id = boundProxy(id)
	if id == "" || len(id) > maxProxyText {
		return models.Proxy{}, errors.New("proxy: id is invalid")
	}
	fields := []string{}
	args := []any{}
	add := func(name string, v any) { fields = append(fields, name+" = ?"); args = append(args, v) }
	if p.Name != nil {
		v := boundProxy(*p.Name)
		if v == "" || len(v) > maxProxyText {
			return models.Proxy{}, errors.New("proxy: name is invalid")
		}
		add("name", v)
	}
	if p.Protocol != nil {
		if *p.Protocol != "http" && *p.Protocol != "https" && *p.Protocol != "socks5" {
			return models.Proxy{}, errors.New("proxy: unsupported protocol")
		}
		add("protocol", string(*p.Protocol))
	}
	if p.Host != nil {
		v := boundProxy(*p.Host)
		if v == "" || len(v) > maxProxyText {
			return models.Proxy{}, errors.New("proxy: host is invalid")
		}
		add("host", v)
	}
	if p.Port != nil {
		if *p.Port < 1 || *p.Port > 65535 {
			return models.Proxy{}, errors.New("proxy: port is invalid")
		}
		add("port", *p.Port)
	}
	if p.Username != nil {
		add("username", nullString(*p.Username))
	}
	if p.Password != nil {
		add("password", nullString(*p.Password))
	}
	if p.IsRelay != nil {
		add("is_relay", *p.IsRelay)
	}
	if p.MaxConcurrency != nil {
		if *p.MaxConcurrency < 1 || *p.MaxConcurrency > 10000 {
			return models.Proxy{}, errors.New("proxy: max concurrency is invalid")
		}
		add("max_concurrency", *p.MaxConcurrency)
	}
	if p.Priority != nil {
		if *p.Priority < -100000 || *p.Priority > 100000 {
			return models.Proxy{}, errors.New("proxy: priority is invalid")
		}
		add("priority", *p.Priority)
	}
	if p.Weight != nil {
		if *p.Weight < 1 || *p.Weight > 1000 {
			return models.Proxy{}, errors.New("proxy: weight is invalid")
		}
		add("weight", *p.Weight)
	}
	if p.Active != nil {
		add("active", *p.Active)
	}
	if p.CooldownUntil != nil {
		add("cooldown_until", p.CooldownUntil)
	}
	if p.CooldownLevel != nil {
		add("cooldown_level", *p.CooldownLevel)
	}
	if p.ConsecutiveUseCount != nil {
		add("consecutive_use_count", *p.ConsecutiveUseCount)
	}
	if p.LastUsedAt != nil {
		add("last_used_at", p.LastUsedAt)
	}
	if len(fields) == 0 {
		return r.load(ctx, id)
	}
	fields = append(fields, "updated_at = ?")
	args = append(args, time.Now().UTC())
	args = append(args, id)
	res, err := r.db.NewRaw("UPDATE proxies SET "+strings.Join(fields, ", ")+" WHERE id = ?", args...).Exec(ctx)
	if err != nil {
		return models.Proxy{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return models.Proxy{}, sql.ErrNoRows
	}
	return r.load(ctx, id)
}
func (r *BunProxyRepository) RecordTest(ctx context.Context, id string, v models.ProxyTestResult) (models.Proxy, error) {
	if err := r.ready(); err != nil {
		return models.Proxy{}, err
	}
	id = boundProxy(id)
	if len(v.Error) > maxProxyError {
		v.Error = v.Error[:maxProxyError]
	}
	if v.TestedAt.IsZero() {
		v.TestedAt = time.Now().UTC()
	}
	var q string
	var args []any
	if v.OK {
		q = `UPDATE proxies SET last_test_at=?,last_test_success_at=?,last_test_success_latency_ms=?,last_test_status_code=?,last_test_error_at=NULL,last_test_error=NULL,updated_at=? WHERE id=?`
		args = []any{v.TestedAt, v.TestedAt, v.LatencyMs, v.StatusCode, v.TestedAt, id}
	} else {
		q = `UPDATE proxies SET last_test_at=?,last_test_error_at=?,last_test_error=?,last_test_status_code=?,updated_at=? WHERE id=?`
		args = []any{v.TestedAt, v.TestedAt, nullString(v.Error), v.StatusCode, v.TestedAt, id}
	}
	res, err := r.db.NewRaw(q, args...).Exec(ctx)
	if err != nil {
		return models.Proxy{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return models.Proxy{}, sql.ErrNoRows
	}
	return r.load(ctx, id)
}
func (r *BunProxyRepository) Delete(ctx context.Context, id string) (bool, error) {
	if err := r.ready(); err != nil {
		return false, err
	}
	res, err := r.db.NewRaw(`DELETE FROM proxies WHERE id=?`, boundProxy(id)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, e := res.RowsAffected()
	return n > 0, e
}

type proxySettingsRow struct {
	ID        int       `bun:"id"`
	Enabled   bool      `bun:"enabled"`
	Excluded  []byte    `bun:"excluded_providers_json,type:jsonb"`
	Smart     bool      `bun:"smart_dynamic_routing"`
	Count     int       `bun:"smart_dynamic_proxy_count"`
	Preset    string    `bun:"routing_preset"`
	Target    int       `bun:"target_concurrent"`
	WebSearch string    `bun:"web_search_preference"`
	UpdatedAt time.Time `bun:"updated_at"`
}

func normalizeExcluded(v []string) []string {
	set := map[string]struct{}{}
	for _, s := range v {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" && len(s) <= maxProxyText {
			set[s] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
func settingsModel(r proxySettingsRow) models.ProxySettings {
	var ex []string
	_ = json.Unmarshal(r.Excluded, &ex)
	return models.ProxySettings{Enabled: r.Enabled, ExcludedProviders: normalizeExcluded(ex), SmartDynamicRouting: r.Smart, SmartDynamicProxyCount: r.Count, RoutingPreset: r.Preset, TargetConcurrent: r.Target, WebSearchPreference: r.WebSearch, UpdatedAt: r.UpdatedAt}
}
func (r *BunProxyRepository) GetSettings(ctx context.Context) (models.ProxySettings, error) {
	if err := r.ready(); err != nil {
		return models.ProxySettings{}, err
	}
	var row proxySettingsRow
	if err := r.db.NewSelect().Model(&row).Table("proxy_settings").Where("id=1").Scan(ctx); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.ProxySettings{RoutingPreset: "auto", WebSearchPreference: "auto", SmartDynamicProxyCount: 2}, nil
		}
		return models.ProxySettings{}, err
	}
	return settingsModel(row), nil
}
func (r *BunProxyRepository) PatchSettings(ctx context.Context, p models.ProxySettings) (models.ProxySettings, error) {
	if err := r.ready(); err != nil {
		return models.ProxySettings{}, err
	}
	p.ExcludedProviders = normalizeExcluded(p.ExcludedProviders)
	if p.SmartDynamicProxyCount < 1 {
		p.SmartDynamicProxyCount = 2
	}
	if p.SmartDynamicProxyCount > 32 {
		p.SmartDynamicProxyCount = 32
	}
	if p.TargetConcurrent < 0 {
		p.TargetConcurrent = 0
	}
	if p.TargetConcurrent > 10000 {
		p.TargetConcurrent = 10000
	}
	if p.RoutingPreset != "target-user" && p.RoutingPreset != "target-concurrent" {
		p.RoutingPreset = "auto"
	}
	if p.WebSearchPreference != "always" && p.WebSearchPreference != "never" {
		p.WebSearchPreference = "auto"
	}
	b, _ := json.Marshal(p.ExcludedProviders)
	now := time.Now().UTC()
	_, err := r.db.NewRaw(`INSERT INTO proxy_settings (id,enabled,excluded_providers_json,smart_dynamic_routing,smart_dynamic_proxy_count,routing_preset,target_concurrent,web_search_preference,updated_at) VALUES (1,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET enabled=EXCLUDED.enabled,excluded_providers_json=EXCLUDED.excluded_providers_json,smart_dynamic_routing=EXCLUDED.smart_dynamic_routing,smart_dynamic_proxy_count=EXCLUDED.smart_dynamic_proxy_count,routing_preset=EXCLUDED.routing_preset,target_concurrent=EXCLUDED.target_concurrent,web_search_preference=EXCLUDED.web_search_preference,updated_at=EXCLUDED.updated_at`, p.Enabled, b, p.SmartDynamicRouting, p.SmartDynamicProxyCount, p.RoutingPreset, p.TargetConcurrent, p.WebSearchPreference, now).Exec(ctx)
	if err != nil {
		return models.ProxySettings{}, err
	}
	return r.GetSettings(ctx)
}

type proxyHealthRow struct {
	ProxyID    string     `bun:"proxy_id"`
	Status     string     `bun:"status"`
	ErrorKind  *string    `bun:"error_kind"`
	StatusCode *int       `bun:"status_code"`
	Message    *string    `bun:"sanitized_message"`
	OccurredAt *time.Time `bun:"occurred_at"`
	RetryAt    *time.Time `bun:"retry_at"`
	UpdatedAt  time.Time  `bun:"updated_at"`
}

func (r proxyHealthRow) model() models.ProxyHealth {
	return models.ProxyHealth{ProxyID: r.ProxyID, Status: r.Status, ErrorKind: valueString(r.ErrorKind), StatusCode: r.StatusCode, SanitizedMessage: valueString(r.Message), OccurredAt: r.OccurredAt, RetryAt: r.RetryAt, UpdatedAt: r.UpdatedAt}
}
func (r *BunProxyRepository) GetHealth(ctx context.Context, id string) (models.ProxyHealth, error) {
	if err := r.ready(); err != nil {
		return models.ProxyHealth{}, err
	}
	var row proxyHealthRow
	if err := r.db.NewSelect().Model(&row).Table("proxy_health").Where("proxy_id=?", boundProxy(id)).Scan(ctx); err != nil {
		return models.ProxyHealth{}, err
	}
	return row.model(), nil
}
func (r *BunProxyRepository) UpsertHealth(ctx context.Context, h models.ProxyHealth) error {
	if err := r.ready(); err != nil {
		return err
	}
	h.ProxyID = boundProxy(h.ProxyID)
	h.Status = boundProxy(h.Status)
	h.ErrorKind = boundProxy(h.ErrorKind)
	h.SanitizedMessage = boundProxy(h.SanitizedMessage)
	if len(h.SanitizedMessage) > maxProxyError {
		h.SanitizedMessage = h.SanitizedMessage[:maxProxyError]
	}
	if h.ProxyID == "" || h.Status == "" {
		return errors.New("proxy health: proxy_id and status are required")
	}
	now := h.UpdatedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	_, err := r.db.NewRaw(`INSERT INTO proxy_health (proxy_id,status,error_kind,status_code,sanitized_message,occurred_at,retry_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (proxy_id) DO UPDATE SET status=EXCLUDED.status,error_kind=EXCLUDED.error_kind,status_code=EXCLUDED.status_code,sanitized_message=EXCLUDED.sanitized_message,occurred_at=EXCLUDED.occurred_at,retry_at=EXCLUDED.retry_at,updated_at=EXCLUDED.updated_at`, h.ProxyID, nullString(h.Status), nullString(h.ErrorKind), h.StatusCode, nullString(h.SanitizedMessage), h.OccurredAt, h.RetryAt, now).Exec(ctx)
	return err
}

func (r *BunProxyRepository) ListCustomProviders(ctx context.Context) ([]models.CustomProvider, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	return r.custom.ListCustomProviders(ctx)
}
func (r *BunProxyRepository) GetCustomProvider(ctx context.Context, id string) (models.CustomProvider, error) {
	if err := r.ready(); err != nil {
		return models.CustomProvider{}, err
	}
	return r.custom.GetCustomProvider(ctx, id)
}
func (r *BunProxyRepository) GetCustomProviderBySlug(ctx context.Context, id string) (models.CustomProvider, error) {
	if err := r.ready(); err != nil {
		return models.CustomProvider{}, err
	}
	return r.custom.GetCustomProviderBySlug(ctx, id)
}
func (r *BunProxyRepository) UpsertCustomProvider(ctx context.Context, v models.CustomProvider) (models.CustomProvider, error) {
	if err := r.ready(); err != nil {
		return models.CustomProvider{}, err
	}
	return r.custom.UpsertCustomProvider(ctx, v)
}
func (r *BunProxyRepository) DeleteCustomProvider(ctx context.Context, id string) (bool, error) {
	if err := r.ready(); err != nil {
		return false, err
	}
	return r.custom.DeleteCustomProvider(ctx, id)
}

type warpAccountRow struct {
	ID                  string     `bun:"id"`
	Label               string     `bun:"label"`
	DeviceID            string     `bun:"device_id"`
	AccessToken         string     `bun:"access_token"`
	LicenseKey          string     `bun:"license_key"`
	PrivateKey          string     `bun:"private_key"`
	AddressV4           string     `bun:"address_v4"`
	AddressV6           string     `bun:"address_v6"`
	PublicKey           string     `bun:"public_key"`
	Endpoint            string     `bun:"endpoint"`
	EndpointPort        int        `bun:"endpoint_port"`
	DNS                 string     `bun:"dns"`
	MTU                 int        `bun:"mtu"`
	SocksPort           int        `bun:"socks_port"`
	Enabled             bool       `bun:"enabled"`
	Running             bool       `bun:"running"`
	PID                 *int       `bun:"pid"`
	PreferIPv6          bool       `bun:"prefer_ipv6"`
	CustomEndpoint      *string    `bun:"custom_endpoint"`
	PersistentKeepalive int        `bun:"persistent_keepalive"`
	CreatedAt           time.Time  `bun:"created_at"`
	UpdatedAt           *time.Time `bun:"updated_at"`
}

func (w warpAccountRow) model() models.WarpAccount {
	return models.WarpAccount{ID: w.ID, Label: w.Label, DeviceID: w.DeviceID, AccessToken: w.AccessToken, LicenseKey: w.LicenseKey, PrivateKey: w.PrivateKey, AddressV4: w.AddressV4, AddressV6: w.AddressV6, PublicKey: w.PublicKey, Endpoint: w.Endpoint, EndpointPort: w.EndpointPort, DNS: w.DNS, MTU: w.MTU, SocksPort: w.SocksPort, Enabled: w.Enabled, Running: w.Running, PID: w.PID, PreferIPv6: w.PreferIPv6, CustomEndpoint: valueString(w.CustomEndpoint), PersistentKeepalive: w.PersistentKeepalive, CreatedAt: w.CreatedAt, UpdatedAt: w.UpdatedAt}
}
func (r *BunProxyRepository) ListWarpAccounts(ctx context.Context) ([]models.WarpAccount, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	rows := []warpAccountRow{}
	if err := r.db.NewSelect().Model(&rows).Table("warp_accounts").Order("id ASC").Limit(maxProxyRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.WarpAccount, len(rows))
	for i := range rows {
		out[i] = rows[i].model()
	}
	return out, nil
}
func (r *BunProxyRepository) GetWarpAccount(ctx context.Context, id string) (models.WarpAccount, error) {
	if err := r.ready(); err != nil {
		return models.WarpAccount{}, err
	}
	var w warpAccountRow
	if err := r.db.NewSelect().Model(&w).Table("warp_accounts").Where("id=?", boundProxy(id)).Scan(ctx); err != nil {
		return models.WarpAccount{}, err
	}
	return w.model(), nil
}
func (r *BunProxyRepository) UpsertWarpAccount(ctx context.Context, w models.WarpAccount) (models.WarpAccount, error) {
	if err := r.ready(); err != nil {
		return models.WarpAccount{}, err
	}
	if strings.TrimSpace(w.ID) == "" || strings.TrimSpace(w.DeviceID) == "" {
		return models.WarpAccount{}, errors.New("warp account: id and device_id are required")
	}
	if w.CreatedAt.IsZero() {
		w.CreatedAt = time.Now().UTC()
	}
	now := time.Now().UTC()
	_, err := r.db.NewRaw(`INSERT INTO warp_accounts (id,label,device_id,access_token,license_key,private_key,address_v4,address_v6,public_key,endpoint,endpoint_port,dns,mtu,socks_port,enabled,running,pid,prefer_ipv6,custom_endpoint,persistent_keepalive,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label,device_id=EXCLUDED.device_id,access_token=EXCLUDED.access_token,license_key=EXCLUDED.license_key,private_key=EXCLUDED.private_key,address_v4=EXCLUDED.address_v4,address_v6=EXCLUDED.address_v6,public_key=EXCLUDED.public_key,endpoint=EXCLUDED.endpoint,endpoint_port=EXCLUDED.endpoint_port,dns=EXCLUDED.dns,mtu=EXCLUDED.mtu,socks_port=EXCLUDED.socks_port,enabled=EXCLUDED.enabled,running=EXCLUDED.running,pid=EXCLUDED.pid,prefer_ipv6=EXCLUDED.prefer_ipv6,custom_endpoint=EXCLUDED.custom_endpoint,persistent_keepalive=EXCLUDED.persistent_keepalive,updated_at=EXCLUDED.updated_at`, w.ID, w.Label, w.DeviceID, w.AccessToken, w.LicenseKey, w.PrivateKey, w.AddressV4, w.AddressV6, w.PublicKey, w.Endpoint, w.EndpointPort, w.DNS, w.MTU, w.SocksPort, w.Enabled, w.Running, w.PID, w.PreferIPv6, nullString(w.CustomEndpoint), w.PersistentKeepalive, w.CreatedAt, now).Exec(ctx)
	if err != nil {
		return models.WarpAccount{}, err
	}
	return r.GetWarpAccount(ctx, w.ID)
}
func (r *BunProxyRepository) DeleteWarpAccount(ctx context.Context, id string) (bool, error) {
	if err := r.ready(); err != nil {
		return false, err
	}
	res, err := r.db.NewRaw(`DELETE FROM warp_accounts WHERE id=?`, boundProxy(id)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, e := res.RowsAffected()
	return n > 0, e
}
func (r *BunProxyRepository) RecordWarpMetric(ctx context.Context, m models.WarpMetric) error {
	if err := r.ready(); err != nil {
		return err
	}
	if m.AccountID == "" {
		return errors.New("warp metric: account_id is required")
	}
	_, err := r.db.NewRaw(`INSERT INTO warp_metrics (account_id,label,pid,socks_port,rss_kb,rx_bytes,tx_bytes,healthy,egress_ip,collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, m.AccountID, m.Label, m.PID, m.SocksPort, m.RSSKB, m.RXBytes, m.TXBytes, m.Healthy, m.EgressIP, m.CollectedAt).Exec(ctx)
	return err
}

var _ ProxyRepository = (*BunProxyRepository)(nil)
