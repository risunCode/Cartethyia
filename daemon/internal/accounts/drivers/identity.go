package drivers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/cartethyia/daemon/internal/accounts"
)

// enrichIdentity performs bounded, login-time identity discovery. It is
// deliberately best effort: token persistence remains valid when an optional
// userinfo/project endpoint is unavailable, while any returned identity is
// copied into safe TokenSet metadata only.
func (d *HTTPDriver) enrichIdentity(ctx context.Context, token *accounts.TokenSet) error {
	if d.cfg.DisableIdentityEnrichment || token == nil || token.Access == nil || token.Access.IsZero() {
		return nil
	}
	if d.cfg.Endpoints.UserInfo != "" {
		if body, err := d.getBearer(ctx, d.cfg.Endpoints.UserInfo, token.Access.RevealString()); err == nil {
			if token.ProviderAccountID == "" {
				token.ProviderAccountID = firstString(body, "sub", "id", "user_id", "account_id")
			}
			if token.Email == "" {
				token.Email = firstString(body, "email", "email_address")
			}
			if token.OrgID == "" {
				token.OrgID = firstString(body, "organization_id", "org_id", "project_id")
			}
			if token.OrgName == "" {
				token.OrgName = firstString(body, "organization_name", "org_name", "project_name")
			}
		}
	}
	if d.cfg.ProviderID == ProviderAntigravity && d.cfg.Endpoints.Project != "" {
		if body, err := d.postBearer(ctx, d.cfg.Endpoints.Project, token.Access.RevealString(), map[string]any{}); err == nil {
			project := firstString(body, "project_id", "projectId", "cloudaicompanionProject")
			if project == "" {
				if nested, ok := body["cloudaicompanionProject"].(map[string]any); ok {
					project = firstString(nested, "id", "projectId", "project_id")
				}
			}
			if project != "" {
				token.OrgID = project
			}
		}
	}
	return nil
}

func (d *HTTPDriver) getBearer(ctx context.Context, endpoint, token string) (map[string]any, error) {
	return d.bearerRequest(ctx, http.MethodGet, endpoint, token, nil)
}
func (d *HTTPDriver) postBearer(ctx context.Context, endpoint, token string, value map[string]any) (map[string]any, error) {
	return d.bearerRequest(ctx, http.MethodPost, endpoint, token, value)
}
func (d *HTTPDriver) bearerRequest(ctx context.Context, method, endpoint, token string, value map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	var body io.Reader
	if value != nil {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		body = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if value != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New("identity endpoint unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, d.maxBody+1))
	if err != nil || int64(len(raw)) > d.maxBody {
		return nil, errors.New("identity response exceeded limit")
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
