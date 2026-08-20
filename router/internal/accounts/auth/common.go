// Package auth contains provider-specific OAuth lifecycle implementations.
// Network clients are injected and every response is bounded; no driver logs or
// persists token material.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultTimeout = 30 * time.Second
	DefaultMaxBody = 128 << 10
)

type Endpoints struct {
	Authorize string
	Device    string
	Token     string
	Refresh   string
	UserInfo  string
	Project   string
	Revoke    string
}

type Config struct {
	ProviderID                string
	Kind                      CredentialKind
	Capabilities              Capabilities
	ClientID                  string
	ClientSecret              *Secret
	RedirectURI               string
	Scopes                    []string
	Endpoints                 Endpoints
	HTTPClient                *http.Client
	Timeout                   time.Duration
	MaxBody                   int64
	Now                       func() time.Time
	ExtraAuthorizeParams      map[string]string
	DisableIdentityEnrichment bool
	KiroAWS                   bool
	KiroSocialAuthorize       string
	KiroSocialToken           string
	KiroAWSRegion             string
	KiroAWSStartURL           string
	KiroAWSClientName         string
	KiroAWSClientType         string
	KiroAWSIssuerURL          string
	KiroAWSGrantTypes         []string
}

type tokenState struct {
	verifier     string
	providerID   string
	nonce        string
	deviceCode   *Secret
	expiresAt    time.Time
	mode         string
	clientID     string
	clientSecret *Secret
}

type HTTPDriver struct {
	cfg     Config
	client  *http.Client
	timeout time.Duration
	maxBody int64
	now     func() time.Time
	mu      sync.Mutex
	states  map[string]tokenState
}

func New(cfg Config) (*HTTPDriver, error) {
	cfg.ProviderID = strings.TrimSpace(cfg.ProviderID)
	if cfg.ProviderID == "" {
		return nil, errors.New("oauth driver: provider id is required")
	}
	if cfg.Kind == "" {
		cfg.Kind = KindOAuth
	}
	if cfg.ClientID == "" {
		cfg.ClientID = "cartethyia-public-client"
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = http.DefaultClient
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.MaxBody <= 0 || cfg.MaxBody > 1<<20 {
		cfg.MaxBody = DefaultMaxBody
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Capabilities.AccessOnly {
		cfg.Kind = KindAccessOnly
	}
	return &HTTPDriver{cfg: cfg, client: cfg.HTTPClient, timeout: cfg.Timeout, maxBody: cfg.MaxBody, now: cfg.Now, states: make(map[string]tokenState)}, nil
}

func (d *HTTPDriver) ID() string                          { return d.cfg.ProviderID }
func (d *HTTPDriver) Kind() CredentialKind       { return d.cfg.Kind }
func (d *HTTPDriver) Capabilities() Capabilities { return d.cfg.Capabilities }

func (d *HTTPDriver) Start(ctx context.Context, input OAuthStartInput) (*OAuthStartResult, error) {
	flow := input.Flow
	if flow == "" {
		flow = FlowBrowser
	}
	if flow == FlowBrowser && !d.cfg.Capabilities.Browser {
		return nil, d.unsupported("browser flow")
	}
	if flow == FlowDevice && !d.cfg.Capabilities.Device {
		return nil, d.unsupported("device flow")
	}
	state, err := randomString(32)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	verifier, err := randomString(48)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	if input.State != "" {
		state = bounded(input.State, 128)
	}
	if flow == FlowBrowser {
		challenge := input.CodeChallenge
		if challenge == "" {
			challenge = pkceChallenge(verifier)
		}
		u, err := url.Parse(d.cfg.Endpoints.Authorize)
		if err != nil || u.Scheme != "https" {
			return nil, d.wrap(ErrKindInvalidRequest, errors.New("authorization endpoint is not configured"))
		}
		q := u.Query()
		q.Set("response_type", "code")
		q.Set("client_id", d.cfg.ClientID)
		q.Set("redirect_uri", firstNonEmpty(input.RedirectURI, d.cfg.RedirectURI))
		q.Set("scope", strings.Join(nonEmptyStrings(input.Scopes, d.cfg.Scopes), " "))
		q.Set("state", state)
		q.Set("code_challenge", challenge)
		q.Set("code_challenge_method", "S256")
		nonce := ""
		for k, v := range d.cfg.ExtraAuthorizeParams {
			if k == "nonce" && v == "required" {
				nonce, err = randomString(24)
				if err != nil {
					return nil, d.wrap(ErrKindUnknown, err)
				}
				q.Set(k, nonce)
				continue
			}
			if k != "" && v != "" {
				q.Set(k, bounded(v, 256))
			}
		}
		u.RawQuery = q.Encode()
		d.mu.Lock()
		d.states[state] = tokenState{verifier: verifier, providerID: d.cfg.ProviderID, nonce: nonce}
		d.mu.Unlock()
		return &OAuthStartResult{AuthorizationURL: u.String(), State: state, CodeVerifier: verifier, ExpiresAt: d.now().Add(10 * time.Minute), Flow: flow}, nil
	}
	if d.cfg.Endpoints.Device == "" {
		return nil, d.unsupported("device endpoint")
	}
	body := url.Values{"client_id": {d.cfg.ClientID}, "scope": {strings.Join(nonEmptyStrings(input.Scopes, d.cfg.Scopes), " ")}}
	if d.cfg.ClientSecret != nil && !d.cfg.ClientSecret.IsZero() {
		body.Set("client_secret", d.cfg.ClientSecret.RevealString())
	}
	result, err := d.request(ctx, http.MethodPost, d.cfg.Endpoints.Device, "application/x-www-form-urlencoded", []byte(body.Encode()))
	if err != nil {
		return nil, err
	}
	deviceCode := stringField(result, "device_code")
	if deviceCode == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("device response missing device code"))
	}
	expires := intField(result, "expires_in")
	if expires <= 0 || expires > 3600 {
		expires = 900
	}
	interval := intField(result, "interval")
	if interval < 1 || interval > 300 {
		interval = 5
	}
	verification := firstString(result, "verification_uri", "verification_url")
	d.mu.Lock()
	d.states[state] = tokenState{providerID: d.cfg.ProviderID, deviceCode: NewSecretFromString(deviceCode), expiresAt: d.now().Add(time.Duration(expires) * time.Second)}
	d.mu.Unlock()
	return &OAuthStartResult{State: state, UserCode: bounded(stringField(result, "user_code"), 128), VerificationURI: bounded(verification, 2048), IntervalSeconds: interval, ExpiresAt: d.now().Add(time.Duration(expires) * time.Second), Flow: flow}, nil
}

func (d *HTTPDriver) Poll(ctx context.Context, state string) (*OAuthPollResult, error) {
	if !d.cfg.Capabilities.Poll {
		return nil, d.unsupported("device polling")
	}
	d.mu.Lock()
	st, ok := d.states[strings.TrimSpace(state)]
	deviceCode := ""
	if ok && st.deviceCode != nil {
		deviceCode = st.deviceCode.RevealString()
	}
	d.mu.Unlock()
	if !ok || deviceCode == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("device session not found"))
	}
	if !st.expiresAt.IsZero() && !st.expiresAt.After(d.now()) {
		return &OAuthPollResult{Status: PollExpired}, nil
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {deviceCode}, "client_id": {d.cfg.ClientID}}
	if d.cfg.ClientSecret != nil && !d.cfg.ClientSecret.IsZero() {
		form.Set("client_secret", d.cfg.ClientSecret.RevealString())
	}
	result, err := d.requestResult(ctx, http.MethodPost, d.cfg.Endpoints.Token, "application/x-www-form-urlencoded", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}
	if !result.ok {
		code := strings.ToLower(firstString(result.body, "error", "code"))
		switch code {
		case "authorization_pending", "pending":
			return &OAuthPollResult{Status: PollPending}, nil
		case "slow_down":
			return &OAuthPollResult{Status: PollPending, IntervalSeconds: 15}, nil
		case "expired_token", "expired":
			return &OAuthPollResult{Status: PollExpired}, nil
		case "access_denied", "denied":
			return &OAuthPollResult{Status: PollDenied}, nil
		}
		return nil, d.httpError(result.status, code)
	}
	ts, err := d.tokenSet(result.body, OriginOAuthDevice, false)
	if err != nil {
		return nil, err
	}
	if err := d.enrichIdentity(ctx, ts); err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.deleteStateLocked(state)
	d.mu.Unlock()
	return &OAuthPollResult{Status: PollCompleted, TokenSet: ts}, nil
}

func (d *HTTPDriver) Exchange(ctx context.Context, input OAuthExchangeInput) (*TokenSet, error) {
	if !d.cfg.Capabilities.Exchange {
		return nil, d.unsupported("authorization exchange")
	}
	if strings.TrimSpace(input.Code) == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("authorization code is required"))
	}
	verifier := input.CodeVerifier
	d.mu.Lock()
	st, ok := d.states[input.State]
	if verifier == "" && ok {
		verifier = st.verifier
	}
	d.mu.Unlock()
	if d.cfg.ProviderID == ProviderGrokBuild && (!ok || strings.TrimSpace(input.State) == "") {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Grok browser session is missing or expired"))
	}
	if verifier == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("PKCE verifier is required"))
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {d.cfg.ClientID}, "code": {strings.TrimSpace(input.Code)}, "redirect_uri": {firstNonEmpty(input.RedirectURI, d.cfg.RedirectURI)}, "code_verifier": {verifier}}
	if st.nonce != "" {
		form.Set("nonce", st.nonce)
	}
	if d.cfg.ClientSecret != nil && !d.cfg.ClientSecret.IsZero() {
		form.Set("client_secret", d.cfg.ClientSecret.RevealString())
	}
	result, err := d.requestResult(ctx, http.MethodPost, d.cfg.Endpoints.Token, "application/x-www-form-urlencoded", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}
	if !result.ok {
		return nil, d.httpError(result.status, firstString(result.body, "error", "code"))
	}
	ts, err := d.tokenSet(result.body, OriginOAuth, d.cfg.Capabilities.Refresh && !d.cfg.Capabilities.AccessOnly)
	if err == nil {
		err = d.enrichIdentity(ctx, ts)
	}
	if err == nil && input.State != "" {
		d.mu.Lock()
		d.deleteStateLocked(input.State)
		d.mu.Unlock()
	}
	return ts, err
}

func (d *HTTPDriver) Refresh(ctx context.Context, input RefreshTokenInput) (*TokenSet, error) {
	if !d.cfg.Capabilities.Refresh || d.cfg.Capabilities.AccessOnly {
		return nil, NewError(ErrKindReauthentication, d.cfg.ProviderID, input.AccountID, errors.New("provider credential is access-only"))
	}
	if input.RefreshToken == nil || input.RefreshToken.IsZero() {
		return nil, NewError(ErrKindReauthentication, d.cfg.ProviderID, input.AccountID, errors.New("refresh token is missing"))
	}
	endpoint := d.cfg.Endpoints.Refresh
	if endpoint == "" {
		endpoint = d.cfg.Endpoints.Token
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {d.cfg.ClientID}, "refresh_token": {input.RefreshToken.RevealString()}}
	if d.cfg.ClientSecret != nil && !d.cfg.ClientSecret.IsZero() {
		form.Set("client_secret", d.cfg.ClientSecret.RevealString())
	}
	result, err := d.requestResult(ctx, http.MethodPost, endpoint, "application/x-www-form-urlencoded", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}
	if !result.ok {
		return nil, d.httpError(result.status, firstString(result.body, "error", "code"))
	}
	return d.tokenSetWithRefresh(result.body, OriginOAuthRefresh, false, input.RefreshToken)
}

func (d *HTTPDriver) Revoke(ctx context.Context, input RevokeTokenInput) error {
	if !d.cfg.Capabilities.Revoke {
		return d.unsupported("revoke")
	}
	if input.Token == nil || input.Token.IsZero() {
		return d.wrap(ErrKindInvalidRequest, errors.New("revoke token is required"))
	}
	if d.cfg.Endpoints.Revoke == "" {
		return d.unsupported("revoke endpoint")
	}
	form := url.Values{"token": {input.Token.RevealString()}, "client_id": {d.cfg.ClientID}}
	_, err := d.request(ctx, http.MethodPost, d.cfg.Endpoints.Revoke, "application/x-www-form-urlencoded", []byte(form.Encode()))
	return err
}

func (d *HTTPDriver) tokenSet(body map[string]any, origin CredentialOrigin, requireRefresh bool) (*TokenSet, error) {
	return d.tokenSetWithRefresh(body, origin, requireRefresh, nil)
}
func (d *HTTPDriver) tokenSetWithRefresh(body map[string]any, origin CredentialOrigin, requireRefresh bool, old *Secret) (*TokenSet, error) {
	access := firstString(body, "access_token", "accessToken", "token")
	if access == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("token response missing access token"))
	}
	refresh := firstString(body, "refresh_token", "refreshToken")
	if refresh == "" && requireRefresh && old == nil {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("token response missing refresh token"))
	}
	expires := intField(body, "expires_in")
	if expires <= 0 {
		expires = intField(body, "expiresIn")
	}
	var expiry time.Time
	if expires > 0 && expires < 365*24*3600 {
		expiry = d.now().Add(time.Duration(expires) * time.Second)
	}
	ts := &TokenSet{Access: NewSecretFromString(access), Origin: origin, ExpiresAt: expiry, Scope: firstString(body, "scope"), ProviderAccountID: firstString(body, "provider_account_id", "account_id", "accountId", "sub"), Email: firstString(body, "email", "email_address"), OrgID: firstString(body, "organization_id", "org_id", "orgId"), OrgName: firstString(body, "organization_name", "org_name", "orgName")}
	if refresh != "" {
		ts.Refresh = NewSecretFromString(refresh)
	} else if old != nil {
		ts.Refresh = NewSecret(old.Reveal())
	}
	if ts.ProviderAccountID == "" {
		claims := jwtClaims(access)
		ts.ProviderAccountID = firstString(claims, "sub", "account_id", "accountId")
		if ts.Email == "" {
			ts.Email = firstString(claims, "email", "email_address")
		}
	}
	return ts, nil
}

func (d *HTTPDriver) request(ctx context.Context, method, endpoint, contentType string, body []byte) (map[string]any, error) {
	r, err := d.requestResult(ctx, method, endpoint, contentType, body)
	if err != nil {
		return nil, err
	}
	if !r.ok {
		return nil, d.httpError(r.status, firstString(r.body, "error", "code"))
	}
	return r.body, nil
}

type responseResult struct {
	ok         bool
	status     int
	body       map[string]any
	retryAfter time.Duration
}

func (d *HTTPDriver) requestResult(ctx context.Context, method, endpoint, contentType string, body []byte) (responseResult, error) {
	if endpoint == "" {
		return responseResult{}, d.wrap(ErrKindInvalidRequest, errors.New("OAuth endpoint is not configured"))
	}
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return responseResult{}, d.wrap(ErrKindInvalidRequest, err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	resp, err := d.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return responseResult{}, NewError(ErrKindRefreshTransient, d.cfg.ProviderID, "", context.DeadlineExceeded)
		}
		return responseResult{}, NewError(ErrKindRefreshTransient, d.cfg.ProviderID, "", errors.New("OAuth network request failed"))
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, d.maxBody+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return responseResult{}, NewError(ErrKindUnknown, d.cfg.ProviderID, "", errors.New("OAuth response read failed"))
	}
	if int64(len(raw)) > d.maxBody {
		return responseResult{}, NewError(ErrKindUnknown, d.cfg.ProviderID, "", errors.New("OAuth response exceeded limit"))
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil && resp.StatusCode < 300 {
			return responseResult{}, NewError(ErrKindUnknown, d.cfg.ProviderID, "", errors.New("OAuth response malformed"))
		}
	}
	var retry time.Duration
	if value := resp.Header.Get("Retry-After"); value != "" {
		if seconds, e := strconv.Atoi(strings.TrimSpace(value)); e == nil && seconds >= 0 && seconds <= 3600 {
			retry = time.Duration(seconds) * time.Second
		}
	}
	return responseResult{ok: resp.StatusCode >= 200 && resp.StatusCode < 300, status: resp.StatusCode, body: out, retryAfter: retry}, nil
}
func (d *HTTPDriver) httpError(status int, code string) error {
	rawCode := strings.ToUpper(strings.TrimSpace(code))
	if rawCode == "" {
		rawCode = fmt.Sprintf("HTTP_%d", status)
	}
	rawCode = strings.NewReplacer(" ", "_", ".", "_", "-", "_").Replace(rawCode)
	if d.cfg.ProviderID == ProviderGrokBuild {
		rawCode = "GROK_OAUTH_" + rawCode
	} else {
		rawCode = strings.ToUpper(d.cfg.ProviderID) + "_OAUTH_" + rawCode
	}
	kind := ErrKindRefreshFatal
	if status >= 500 || status == 408 || status == 429 {
		kind = ErrKindRefreshTransient
	}
	if status == 400 || status == 422 {
		kind = ErrKindInvalidRequest
	}
	if status == 401 || status == 403 || strings.Contains(strings.ToLower(code), "invalid_grant") || strings.Contains(strings.ToLower(code), "revoked") {
		kind = ErrKindReauthentication
	}
	return NewProviderError(kind, d.cfg.ProviderID, "", rawCode, fmt.Errorf("OAuth provider rejected request (%d)", status))
}
func (d *HTTPDriver) unsupported(op string) error {
	return NewError(ErrKindInvalidRequest, d.cfg.ProviderID, "", fmt.Errorf("%s is unsupported", op))
}

// deleteStateLocked releases any secret material retained for an in-flight
// device session before removing the session from the driver map.
func (d *HTTPDriver) deleteStateLocked(id string) {
	st, ok := d.states[id]
	if !ok {
		return
	}
	st.deviceCode.Close()
	st.clientSecret.Close()
	delete(d.states, id)
}

func (d *HTTPDriver) wrap(kind ErrorKind, err error) error {
	return NewError(kind, d.cfg.ProviderID, "", err)
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func pkceChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func bounded(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
func nonEmptyStrings(first, fallback []string) []string {
	if len(first) > 0 {
		return first
	}
	return fallback
}
func stringField(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return strings.TrimSpace(v)
}
func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v := stringField(m, k); v != "" {
			return bounded(v, 512)
		}
	}
	return ""
}
func intField(m map[string]any, k string) int {
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case json.Number:
		i, _ := strconv.Atoi(v.String())
		return i
	case int:
		return v
	}
	return 0
}
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	out := map[string]any{}
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}
