package drivers

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"

	"github.com/cartethyia/daemon/internal/accounts"
)

const (
	ProviderAntigravity = "antigravity"
	ProviderClaude      = "claude"
	ProviderCline       = "cline"
	ProviderClinePass   = "clinepass"
	ProviderCodex       = "codex"
	ProviderGrokBuild   = "grok-build"
	ProviderKimchi      = "kimchi"
	ProviderKiro        = "kiro"
)

var supportedIDs = []string{ProviderAntigravity, ProviderClaude, ProviderCline, ProviderClinePass, ProviderCodex, ProviderGrokBuild, ProviderKimchi, ProviderKiro}

type Registry struct {
	drivers map[string]accounts.AuthDriver
}

func NewRegistry(configs map[string]Config) (*Registry, error) {
	r := &Registry{drivers: make(map[string]accounts.AuthDriver, len(supportedIDs))}
	for _, id := range supportedIDs {
		cfg := defaultConfig(id)
		if override, ok := configs[id]; ok {
			cfg = mergeConfig(cfg, override)
		}
		var (
			d   accounts.AuthDriver
			err error
		)
		if id == ProviderKiro {
			d, err = NewKiro(cfg)
		} else {
			d, err = New(cfg)
		}
		if err != nil {
			return nil, fmt.Errorf("driver %s: %w", id, err)
		}
		r.drivers[id] = d
	}
	return r, nil
}

func (r *Registry) Get(id string) (accounts.AuthDriver, bool) {
	if r == nil {
		return nil, false
	}
	d, ok := r.drivers[normalizeID(id)]
	return d, ok
}
func (r *Registry) IDs() []string {
	if r == nil {
		return nil
	}
	out := make([]string, 0, len(r.drivers))
	for id := range r.drivers {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
func (r *Registry) Has(id string) bool { _, ok := r.Get(id); return ok }
func SupportedIDs() []string           { return append([]string(nil), supportedIDs...) }
func NormalizeID(id string) string     { return normalizeID(id) }

func defaultConfig(id string) Config {
	base := Config{ProviderID: id, Kind: accounts.KindOAuth, ClientID: "cartethyia-public-client", RedirectURI: "http://127.0.0.1/callback", Scopes: []string{"openid", "profile", "email"}, Capabilities: accounts.Capabilities{Browser: true, Exchange: true, Refresh: true, Revoke: true}}
	switch id {
	case ProviderClaude:
		base.ClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
		base.RedirectURI = "http://127.0.0.1:54545/callback"
		base.Scopes = []string{"org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"}
		base.Endpoints = Endpoints{Authorize: "https://claude.ai/oauth/authorize", Token: "https://api.anthropic.com/v1/oauth/token", Refresh: "https://api.anthropic.com/v1/oauth/token", UserInfo: "https://api.anthropic.com/api/claude_cli/bootstrap"}
	case ProviderAntigravity:
		// Google classifies this as an installed-app client. Keep the bundled
		// client material obfuscated in the binary/source, matching the
		// provider's public-client distribution model; user OAuth tokens are
		// persisted separately by the account secret store.
		base.ClientID = decodeBundledOAuthValue("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==")
		base.ClientSecret = accounts.NewSecretFromString(decodeBundledOAuthValue("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="))
		base.RedirectURI = "http://127.0.0.1:51121/oauth-callback"
		base.Scopes = []string{"https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"}
		base.Endpoints = Endpoints{Authorize: "https://accounts.google.com/o/oauth2/v2/auth", Token: "https://oauth2.googleapis.com/token", Refresh: "https://oauth2.googleapis.com/token", UserInfo: "https://www.googleapis.com/oauth2/v3/userinfo", Project: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"}
	case ProviderCodex:
		base.Capabilities.Device = true
		base.Capabilities.Poll = true
		base.Endpoints = Endpoints{Authorize: "https://auth.openai.com/oauth/authorize", Device: "https://auth.openai.com/api/accounts/deviceauth", Token: "https://auth.openai.com/oauth/token", Refresh: "https://auth.openai.com/oauth/token"}
		base.ExtraAuthorizeParams = map[string]string{"originator": "cartethyia"}
	case ProviderCline:
		base.Kind = accounts.KindDevice
		base.Capabilities.Browser = false
		base.Capabilities.Device = true
		base.Capabilities.Revoke = false
		base.Endpoints = Endpoints{Device: "https://app.cline.bot/oauth/device", Token: "https://app.cline.bot/oauth/token", Refresh: "https://app.cline.bot/oauth/token"}
	case ProviderClinePass:
		base.Capabilities.Browser = true
		base.Capabilities.Device = true
		base.Capabilities.Poll = true
		base.Endpoints = Endpoints{Authorize: "https://app.cline.bot/oauth/authorize", Device: "https://app.cline.bot/oauth/device", Token: "https://app.cline.bot/oauth/token", Refresh: "https://app.cline.bot/oauth/token"}
	case ProviderGrokBuild:
		base.Endpoints = Endpoints{Authorize: "https://accounts.x.ai/oauth/authorize", Token: "https://accounts.x.ai/oauth/token", Refresh: "https://accounts.x.ai/oauth/token"}
		base.ExtraAuthorizeParams = map[string]string{"nonce": "required"}
	case ProviderKiro:
		base.Kind = accounts.KindDevice
		base.Capabilities = accounts.Capabilities{Browser: true, Device: true, Poll: true, Exchange: true, Refresh: true}
		base.Endpoints = Endpoints{Device: "https://oidc.us-east-1.amazonaws.com/device_authorization", Token: "https://oidc.us-east-1.amazonaws.com/token", Refresh: "https://oidc.us-east-1.amazonaws.com/token"}
		base.KiroAWS = true
		base.KiroAWSRegion = "us-east-1"
		base.KiroAWSStartURL = "https://view.awsapps.com/start"
		base.KiroAWSClientName = "kiro-oauth-client"
		base.KiroAWSClientType = "public"
		base.KiroAWSIssuerURL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6"
		base.KiroAWSGrantTypes = []string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"}
		base.KiroSocialAuthorize = "https://prod.us-east-1.auth.desktop.kiro.dev/login"
		base.KiroSocialToken = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token"
	case ProviderKimchi:
		base.Capabilities = accounts.Capabilities{Browser: true, Exchange: true, AccessOnly: true}
		base.Endpoints = Endpoints{Authorize: "https://kimchi.example.invalid/oauth/authorize", Token: "https://kimchi.example.invalid/oauth/token"}
	}
	return base
}

func decodeBundledOAuthValue(value string) string {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return ""
	}
	return string(decoded)
}
func mergeConfig(base, override Config) Config {
	if strings.TrimSpace(override.ProviderID) != "" {
		base.ProviderID = override.ProviderID
	}
	if override.Kind != "" {
		base.Kind = override.Kind
	}
	if override.Capabilities != (accounts.Capabilities{}) {
		base.Capabilities = override.Capabilities
	}
	if override.ClientID != "" {
		base.ClientID = override.ClientID
	}
	if override.ClientSecret != nil {
		base.ClientSecret = override.ClientSecret
	}
	if override.RedirectURI != "" {
		base.RedirectURI = override.RedirectURI
	}
	if len(override.Scopes) > 0 {
		base.Scopes = append([]string(nil), override.Scopes...)
	}
	base.Endpoints = mergeEndpoints(base.Endpoints, override.Endpoints)
	if override.HTTPClient != nil {
		base.HTTPClient = override.HTTPClient
	}
	if override.Timeout > 0 {
		base.Timeout = override.Timeout
	}
	if override.MaxBody > 0 {
		base.MaxBody = override.MaxBody
	}
	if override.Now != nil {
		base.Now = override.Now
	}
	if override.KiroAWS {
		base.KiroAWS = true
	}
	if override.KiroSocialAuthorize != "" {
		base.KiroSocialAuthorize = override.KiroSocialAuthorize
	}
	if override.KiroSocialToken != "" {
		base.KiroSocialToken = override.KiroSocialToken
	}
	if override.KiroAWSRegion != "" {
		base.KiroAWSRegion = override.KiroAWSRegion
	}
	if override.KiroAWSStartURL != "" {
		base.KiroAWSStartURL = override.KiroAWSStartURL
	}
	if override.KiroAWSClientName != "" {
		base.KiroAWSClientName = override.KiroAWSClientName
	}
	if override.KiroAWSClientType != "" {
		base.KiroAWSClientType = override.KiroAWSClientType
	}
	if override.KiroAWSIssuerURL != "" {
		base.KiroAWSIssuerURL = override.KiroAWSIssuerURL
	}
	if len(override.KiroAWSGrantTypes) > 0 {
		base.KiroAWSGrantTypes = append([]string(nil), override.KiroAWSGrantTypes...)
	}
	if len(override.ExtraAuthorizeParams) > 0 {
		if base.ExtraAuthorizeParams == nil {
			base.ExtraAuthorizeParams = map[string]string{}
		}
		for k, v := range override.ExtraAuthorizeParams {
			base.ExtraAuthorizeParams[k] = v
		}
	}
	return base
}
func mergeEndpoints(a, b Endpoints) Endpoints {
	if b.Authorize != "" {
		a.Authorize = b.Authorize
	}
	if b.Device != "" {
		a.Device = b.Device
	}
	if b.Token != "" {
		a.Token = b.Token
	}
	if b.Refresh != "" {
		a.Refresh = b.Refresh
	}
	if b.UserInfo != "" {
		a.UserInfo = b.UserInfo
	}
	if b.Project != "" {
		a.Project = b.Project
	}
	if b.Revoke != "" {
		a.Revoke = b.Revoke
	}
	return a
}
func normalizeID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if id == "grok" {
		return ProviderGrokBuild
	}
	if id == "cline-pass" {
		return ProviderClinePass
	}
	return id
}
