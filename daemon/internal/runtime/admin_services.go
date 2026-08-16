package runtime

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/database/models"
	repos "github.com/cartethyia/daemon/internal/database/repositories"
	admin "github.com/cartethyia/daemon/internal/server/admin"
)

type postgresAPIKeyAdminService struct{ repository repos.APIKeyRepository }

func (s *postgresAPIKeyAdminService) List(ctx context.Context) ([]admin.APIKey, error) {
	rows, e := s.repository.List(ctx)
	if e != nil {
		return nil, e
	}
	out := make([]admin.APIKey, len(rows))
	for i := range rows {
		out[i] = projectAPIKey(rows[i])
	}
	return out, nil
}
func (s *postgresAPIKeyAdminService) Create(ctx context.Context, in admin.APIKeyInput) (admin.APIKeyCreateResult, error) {
	key, e := randomAdminSecret(32)
	if e != nil {
		return admin.APIKeyCreateResult{}, e
	}
	id, e := randomAdminID("key")
	if e != nil {
		return admin.APIKeyCreateResult{}, e
	}
	row, e := s.repository.Create(ctx, models.ApiKeyCreateInput{ID: id, Name: in.Name, Key: key})
	if e != nil {
		return admin.APIKeyCreateResult{}, e
	}
	return admin.APIKeyCreateResult{Record: projectAPIKey(row), Key: key}, nil
}
func (s *postgresAPIKeyAdminService) Update(ctx context.Context, id string, in admin.APIKeyInput) (admin.APIKey, error) {
	var p models.ApiKeyPatchInput
	if in.Name != "" {
		p.Name = &in.Name
	}
	row, e := s.repository.Patch(ctx, id, p)
	if e != nil {
		return admin.APIKey{}, e
	}
	return projectAPIKey(row), nil
}
func (s *postgresAPIKeyAdminService) Regenerate(ctx context.Context, id string) (admin.APIKeyCreateResult, error) {
	key, e := randomAdminSecret(32)
	if e != nil {
		return admin.APIKeyCreateResult{}, e
	}
	row, e := s.repository.Patch(ctx, id, models.ApiKeyPatchInput{Key: &key})
	if e != nil {
		return admin.APIKeyCreateResult{}, e
	}
	return admin.APIKeyCreateResult{Record: projectAPIKey(row), Key: key}, nil
}
func (s *postgresAPIKeyAdminService) Revoke(ctx context.Context, id string) error {
	_, e := s.repository.Revoke(ctx, id)
	return e
}
func (s *postgresAPIKeyAdminService) Delete(ctx context.Context, id string) error {
	_, e := s.repository.Delete(ctx, id)
	return e
}
func (s *postgresAPIKeyAdminService) Credential(ctx context.Context, id string) (string, error) {
	return s.repository.Credential(ctx, id)
}
func (s *postgresAPIKeyAdminService) ShareLink(ctx context.Context, id, kind, base string) (admin.ShareLink, error) {
	token, e := randomAdminSecret(24)
	if e != nil {
		return admin.ShareLink{}, e
	}
	linkID, e := randomAdminID("share")
	if e != nil {
		return admin.ShareLink{}, e
	}
	sum := sha256.Sum256([]byte(token))
	row, e := s.repository.CreateShareLink(ctx, models.ShareLink{ID: linkID, APIKeyID: id, TokenHash: fmt.Sprintf("%x", sum[:]), Kind: kind, Active: true, CreatedAt: time.Now().UTC(), ExpiresAt: ptrTime(time.Now().UTC().Add(24 * time.Hour))})
	if e != nil {
		return admin.ShareLink{}, e
	}
	return admin.ShareLink{URL: strings.TrimRight(base, "/") + "/v2/admin/keys/share/" + url.PathEscape(row.ID) + "?token=" + url.QueryEscape(token), Kind: row.Kind, ExpiresAt: row.ExpiresAt.UTC().Format(time.RFC3339)}, nil
}
func (s *postgresAPIKeyAdminService) RevokeShareLinks(ctx context.Context, id string) (int, error) {
	rows, e := s.repository.ListShareLinksByAPIKey(ctx, id)
	if e != nil {
		return 0, e
	}
	n := 0
	for _, row := range rows {
		if row.Active {
			if _, e = s.repository.PatchShareLinkActive(ctx, row.ID, false); e != nil {
				return n, e
			}
			n++
		}
	}
	return n, nil
}

type postgresProxyAdminService struct{ repository repos.ProxyRepository }

func (s *postgresProxyAdminService) List(ctx context.Context, limit int) ([]admin.Proxy, error) {
	rows, e := s.repository.List(ctx)
	if e != nil {
		return nil, e
	}
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return projectProxies(rows), nil
}
func (s *postgresProxyAdminService) Create(ctx context.Context, in admin.ProxyInput) (admin.Proxy, error) {
	active := true
	if in.Enabled != nil {
		active = *in.Enabled
	}
	row, e := s.repository.Create(ctx, models.ProxyCreateInput{ID: in.Label, Name: in.Label, Protocol: models.ProxyProtocol(in.Protocol), Host: in.Host, Port: in.Port, Username: in.Username, Password: in.Password, Active: active})
	if e != nil {
		return admin.Proxy{}, e
	}
	return projectProxy(row), nil
}
func (s *postgresProxyAdminService) Update(ctx context.Context, id string, in admin.ProxyInput) (admin.Proxy, error) {
	var p models.ProxyPatchInput
	if in.Label != "" {
		p.Name = &in.Label
	}
	if in.Protocol != "" {
		v := models.ProxyProtocol(in.Protocol)
		p.Protocol = &v
	}
	if in.Host != "" {
		p.Host = &in.Host
	}
	if in.Port != 0 {
		p.Port = &in.Port
	}
	if in.Username != "" {
		p.Username = &in.Username
	}
	if in.Password != "" {
		p.Password = &in.Password
	}
	p.Active = in.Enabled
	row, e := s.repository.Patch(ctx, id, p)
	if e != nil {
		return admin.Proxy{}, e
	}
	return projectProxy(row), nil
}
func (s *postgresProxyAdminService) Delete(ctx context.Context, id string) error {
	_, e := s.repository.Delete(ctx, id)
	return e
}
func (s *postgresProxyAdminService) Credential(ctx context.Context, id string) (string, error) {
	row, e := s.repository.Get(ctx, id)
	if e != nil {
		return "", e
	}
	return row.Password, nil
}
func (s *postgresProxyAdminService) Test(context.Context, string) (admin.ProxyTestResult, error) {
	return admin.ProxyTestResult{}, errors.New("proxy test unavailable: probe transport is not composed")
}
func (s *postgresProxyAdminService) TestAdHoc(context.Context, admin.ProxyInput) (admin.ProxyTestResult, error) {
	return admin.ProxyTestResult{}, errors.New("proxy test unavailable: probe transport is not composed")
}
func (s *postgresProxyAdminService) Search(ctx context.Context, in admin.ProxySearchInput) ([]admin.Proxy, error) {
	rows, e := s.repository.List(ctx)
	if e != nil {
		return nil, e
	}
	q := strings.ToLower(strings.TrimSpace(in.Query))
	out := make([]admin.Proxy, 0)
	for _, r := range rows {
		if q != "" && !strings.Contains(strings.ToLower(r.Name), q) && !strings.Contains(strings.ToLower(r.Host), q) {
			continue
		}
		out = append(out, projectProxy(r))
	}
	if in.Limit > 0 && len(out) > in.Limit {
		out = out[:in.Limit]
	}
	return out, nil
}
func (s *postgresProxyAdminService) Import(ctx context.Context, in admin.ProxyImportInput) (admin.BatchResult, error) {
	r := admin.BatchResult{Processed: len(in.Proxies)}
	for _, p := range in.Proxies {
		if _, e := s.Create(ctx, p); e != nil {
			r.Failed++
			r.Errors = append(r.Errors, "operation failed")
		} else {
			r.Succeeded++
		}
	}
	return r, nil
}
func (s *postgresProxyAdminService) Scrape(context.Context, admin.ProxyScrapeInput) (admin.BatchResult, error) {
	return admin.BatchResult{}, errors.New("proxy scraping unavailable: scraper is not composed")
}
func (s *postgresProxyAdminService) Settings(ctx context.Context) (admin.ProxySettings, error) {
	r, ok := s.repository.(interface {
		GetSettings(context.Context) (models.ProxySettings, error)
	})
	if !ok {
		return admin.ProxySettings{}, errors.New("proxy settings unavailable")
	}
	v, e := r.GetSettings(ctx)
	if e != nil {
		return admin.ProxySettings{}, e
	}
	return admin.ProxySettings{Mode: v.RoutingPreset, AllowList: append([]string(nil), v.ExcludedProviders...)}, nil
}
func (s *postgresProxyAdminService) PatchSettings(ctx context.Context, in admin.ProxySettingsInput) (admin.ProxySettings, error) {
	r, ok := s.repository.(interface {
		PatchSettings(context.Context, models.ProxySettings) (models.ProxySettings, error)
	})
	if !ok {
		return admin.ProxySettings{}, errors.New("proxy settings unavailable")
	}
	mode := ""
	if in.Mode != nil {
		mode = *in.Mode
	}
	v, e := r.PatchSettings(ctx, models.ProxySettings{RoutingPreset: mode, ExcludedProviders: append([]string(nil), in.AllowList...)})
	if e != nil {
		return admin.ProxySettings{}, e
	}
	return admin.ProxySettings{Mode: v.RoutingPreset, AllowList: v.ExcludedProviders}, nil
}
func (s *postgresProxyAdminService) Countries(context.Context) ([]string, error) {
	return nil, errors.New("proxy countries unavailable: scraper is not composed")
}
func (s *postgresProxyAdminService) ScrapeCatalog(context.Context) []admin.ScrapeSourceInfo {
	return nil
}

type postgresDashboardAdminService struct {
	accounts interface {
		List(context.Context) ([]*accounts.AccountConfig, error)
	}
	proxies     repos.ProxyRepository
	keys        repos.APIKeyRepository
	environment string
	started     time.Time
}

// daemonBuildVersion reports the module version embedded by the toolchain.
// Binaries without version metadata fall back to "dev".
var daemonBuildVersion = func() string {
	info, ok := debug.ReadBuildInfo()
	if !ok || info.Main.Version == "" || info.Main.Version == "(devel)" {
		return "dev"
	}
	return info.Main.Version
}()

func (s *postgresDashboardAdminService) Summary(ctx context.Context) (admin.DashboardSummary, error) {
	var out admin.DashboardSummary
	out.Version = daemonBuildVersion
	out.Environment = s.environment
	if out.Environment == "" {
		out.Environment = "development"
	}
	if !s.started.IsZero() {
		out.Uptime = time.Since(s.started).Truncate(time.Second).String()
	}
	if s.accounts != nil {
		rows, err := s.accounts.List(ctx)
		if err != nil {
			return out, err
		}
		out.AccountCount = len(rows)
	}
	if s.proxies != nil {
		rows, err := s.proxies.List(ctx)
		if err != nil {
			return out, err
		}
		out.ProxyCount = len(rows)
	}
	if s.keys != nil {
		rows, err := s.keys.List(ctx)
		if err != nil {
			return out, err
		}
		out.APIKeyCount = len(rows)
	}
	out.Health = map[string]any{"database": "postgresql"}
	return out, nil
}

func projectAPIKey(v models.ApiKey) admin.APIKey {
	return admin.APIKey{ID: v.ID, Name: v.Name, CreatedAt: v.CreatedAt.UTC().Format(time.RFC3339), LastUsedAt: formatAdminTime(v.LastUsedAt), Metadata: map[string]any{"active": v.Active, "keyPrefix": v.KeyPrefix}}
}
func projectProxy(v models.Proxy) admin.Proxy {
	return admin.Proxy{ID: v.ID, Label: v.Name, Protocol: string(v.Protocol), Host: v.Host, Port: v.Port, Username: v.Username, Enabled: v.Active, CreatedAt: v.CreatedAt.UTC().Format(time.RFC3339), UpdatedAt: v.UpdatedAt.UTC().Format(time.RFC3339)}
}
func projectProxies(v []models.Proxy) []admin.Proxy {
	out := make([]admin.Proxy, len(v))
	for i := range v {
		out[i] = projectProxy(v[i])
	}
	return out
}
func formatAdminTime(v *time.Time) string {
	if v == nil || v.IsZero() {
		return ""
	}
	return v.UTC().Format(time.RFC3339)
}
func ptrTime(v time.Time) *time.Time { return &v }
func randomAdminID(prefix string) (string, error) {
	b := make([]byte, 12)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(b), nil
}
func randomAdminSecret(n int) (string, error) {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

var _ admin.APIKeyService = (*postgresAPIKeyAdminService)(nil)
var _ admin.ProxyService = (*postgresProxyAdminService)(nil)
var _ admin.DashboardService = (*postgresDashboardAdminService)(nil)
