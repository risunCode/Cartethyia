package runtime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"runtime/debug"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	repos "github.com/cartethyia/daemon/internal/database/repositories"
	admin "github.com/cartethyia/daemon/internal/server/admin"
)

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

func formatAdminTime(v *time.Time) string {
	if v == nil || v.IsZero() {
		return ""
	}
	return v.UTC().Format(time.RFC3339)
}

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

var _ admin.DashboardService = (*postgresDashboardAdminService)(nil)
