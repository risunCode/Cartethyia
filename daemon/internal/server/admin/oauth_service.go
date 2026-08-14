package admin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/accounts/drivers"
	"github.com/cartethyia/daemon/internal/accounts/flow"
)

const (
	maxOAuthImportBytes = 128 << 10
	maxOAuthModeBytes   = 32
	maxOAuthLabelBytes  = 128
)

// OAuthService composes the provider driver registry, bounded session manager,
// and durable account/token boundaries into the admin OAuth lifecycle. It does
// not expose token material in OAuthState.
type OAuthService struct {
	Drivers   *drivers.Registry
	Sessions  *flow.Manager
	Accounts  accounts.AccountConfigStore
	Secrets   accounts.SecretStore
	Records   accounts.RecordStore
	Refresher accounts.Refresher
	Now       func() time.Time

	mu               sync.Mutex
	accountBySession map[string]string
	polling          map[string]bool
}

var _ OAuthLifecycleService = (*OAuthService)(nil)

func NewOAuthService(driverRegistry *drivers.Registry, sessions *flow.Manager, accountStore accounts.AccountConfigStore, secretStore accounts.SecretStore, recordStore accounts.RecordStore, refresher accounts.Refresher) (*OAuthService, error) {
	if driverRegistry == nil {
		return nil, errors.New("oauth service: driver registry is required")
	}
	if sessions == nil {
		return nil, errors.New("oauth service: session manager is required")
	}
	if accountStore == nil || secretStore == nil || recordStore == nil {
		return nil, errors.New("oauth service: durable account, secret, and record stores are required")
	}
	return &OAuthService{
		Drivers:          driverRegistry,
		Sessions:         sessions,
		Accounts:         accountStore,
		Secrets:          secretStore,
		Records:          recordStore,
		Refresher:        refresher,
		Now:              time.Now,
		accountBySession: make(map[string]string),
		polling:          make(map[string]bool),
	}, nil
}

func (s *OAuthService) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *OAuthService) OAuthStart(ctx context.Context, providerID string, input OAuthStartInput) (OAuthState, error) {
	if s == nil || s.Drivers == nil || s.Sessions == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth service is unavailable")
	}
	providerID = drivers.NormalizeID(strings.TrimSpace(providerID))
	if providerID == "" {
		return OAuthState{}, NewError(CodeInvalidRequest, "provider is required")
	}
	mode := strings.ToLower(strings.TrimSpace(input.Mode))
	if len(mode) > maxOAuthModeBytes {
		return OAuthState{}, NewError(CodeInvalidRequest, "OAuth mode is too long")
	}
	if mode == "manual-json" || mode == "json" || mode == "import" {
		if providerID != drivers.ProviderKiro {
			return OAuthState{}, NewError(CodeInvalidRequest, "manual JSON import is supported only for Kiro")
		}
		return s.importKiroJSON(ctx, input)
	}
	if mode == "social" {
		provider := strings.ToLower(strings.TrimSpace(input.SocialProvider))
		if provider != "google" && provider != "github" {
			return OAuthState{}, NewError(CodeInvalidRequest, "Kiro social provider must be Google or GitHub")
		}
		driver, ok := s.Drivers.Get(providerID)
		if !ok || driver == nil {
			return OAuthState{}, NewError(CodeUnavailable, "OAuth provider is unavailable")
		}
		starter, ok := driver.(drivers.SocialStarter)
		if !ok {
			return OAuthState{}, NewError(CodeUnavailable, "Kiro social browser driver is not configured")
		}
		start, err := starter.StartSocial(ctx, provider, input.RedirectURI)
		if err != nil {
			return OAuthState{}, classifyOAuthError(err)
		}
		session, err := s.Sessions.StartFromOAuth(providerID, accounts.FlowBrowser, *start)
		if err != nil {
			return OAuthState{}, classifyOAuthError(err)
		}
		return s.state(session), nil
	}

	driver, ok := s.Drivers.Get(providerID)
	if !ok || driver == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth provider is unavailable")
	}
	flowKind := accounts.OAuthFlowKind(strings.ToLower(strings.TrimSpace(input.Flow)))
	if flowKind == "" {
		flowKind = accounts.FlowBrowser
	}
	if flowKind != accounts.FlowBrowser && flowKind != accounts.FlowDevice {
		return OAuthState{}, NewError(CodeInvalidRequest, "OAuth flow must be browser or device")
	}
	start, err := driver.Start(ctx, accounts.OAuthStartInput{
		ProviderID:  providerID,
		RedirectURI: boundedOAuthValue(input.RedirectURI, 2048),
		Scopes:      boundedScopes(input.Scopes),
		Flow:        flowKind,
		AWSMode:     boundedOAuthValue(input.AWSMode, 32),
		AWSStartURL: boundedOAuthValue(input.AWSStartURL, 2048),
		AWSRegion:   boundedOAuthValue(input.AWSRegion, 64),
	})
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if start == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth driver returned no start state")
	}
	session, err := s.Sessions.StartFromOAuth(providerID, flowKind, *start)
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	return s.state(session), nil
}

func (s *OAuthService) OAuthStatus(ctx context.Context, sessionID string) (OAuthState, error) {
	if s == nil || s.Sessions == nil || s.Drivers == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth service is unavailable")
	}
	session, err := s.Sessions.Get(sessionID, "")
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if session.Status != flow.StatusPending || session.Flow != accounts.FlowDevice {
		return s.withAccount(session), nil
	}
	driver, ok := s.Drivers.Get(session.ProviderID)
	if !ok || driver == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth provider is unavailable")
	}
	state, err := s.Sessions.StateForDriver(session.ID, session.ProviderID)
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if !s.beginPoll(session.ID) {
		return s.state(session), nil
	}
	defer s.endPoll(session.ID)
	result, err := driver.Poll(ctx, state)
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if result == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth driver returned no poll state")
	}
	switch result.Status {
	case accounts.PollPending:
		return s.state(session), nil
	case accounts.PollExpired:
		updated, updateErr := s.Sessions.Fail(session.ID, session.ProviderID, flow.StatusExpired)
		if updateErr != nil {
			return OAuthState{}, classifyOAuthError(updateErr)
		}
		return s.state(updated), nil
	case accounts.PollDenied:
		updated, updateErr := s.Sessions.Fail(session.ID, session.ProviderID, flow.StatusDenied)
		if updateErr != nil {
			return OAuthState{}, classifyOAuthError(updateErr)
		}
		return s.state(updated), nil
	case accounts.PollCompleted:
		if result.TokenSet == nil || !result.TokenSet.Valid() {
			return OAuthState{}, NewError(CodeInternal, "OAuth driver returned an invalid token set")
		}
		accountID, persistErr := s.persistToken(ctx, session.ProviderID, driver.Kind(), result.TokenSet, map[string]string{"mode": "device"})
		if persistErr != nil {
			return OAuthState{}, persistErr
		}
		updated, updateErr := s.Sessions.CompleteDevice(session.ID, session.ProviderID)
		if updateErr != nil {
			return OAuthState{}, classifyOAuthError(updateErr)
		}
		s.rememberAccount(session.ID, accountID)
		return s.withAccount(updated), nil
	default:
		return OAuthState{}, NewError(CodeInternal, "OAuth driver returned an unknown poll state")
	}
}

func (s *OAuthService) OAuthComplete(ctx context.Context, sessionID string, input OAuthCompleteInput) (OAuthState, error) {
	if s == nil || s.Sessions == nil || s.Drivers == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth service is unavailable")
	}
	session, err := s.Sessions.Get(sessionID, "")
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if session.Flow != accounts.FlowBrowser {
		return OAuthState{}, NewError(CodeInvalidRequest, "device OAuth sessions must be polled")
	}
	if strings.TrimSpace(input.Code) == "" {
		return OAuthState{}, NewError(CodeInvalidRequest, "OAuth callback or code is required")
	}
	driver, ok := s.Drivers.Get(session.ProviderID)
	if !ok || driver == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth provider is unavailable")
	}
	var exchange accounts.OAuthExchangeInput
	var consumed flow.Session
	if strings.HasPrefix(strings.ToLower(input.Code), "kiro://") {
		code, state, callbackErr := parseKiroCallback(input.Code)
		if callbackErr != nil {
			return OAuthState{}, NewError(CodeInvalidRequest, "Kiro callback is invalid").WithCause(callbackErr)
		}
		consumed, exchange, err = s.Sessions.ConsumeCodeForExchange(session.ID, session.ProviderID, code, state, "kiro://kiro.kiroAgent/authenticate-success")
	} else if strings.Contains(input.Code, "://") {
		consumed, exchange, err = s.Sessions.ConsumeCallbackForExchange(session.ID, session.ProviderID, input.Code, "")
	} else {
		consumed, exchange, err = s.Sessions.ConsumeCodeForExchange(session.ID, session.ProviderID, input.Code, input.State, "")
	}
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	tokenSet, err := driver.Exchange(ctx, exchange)
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if tokenSet == nil || !tokenSet.Valid() {
		return OAuthState{}, NewError(CodeInternal, "OAuth driver returned an invalid token set")
	}
	accountID, err := s.persistToken(ctx, session.ProviderID, driver.Kind(), tokenSet, map[string]string{"mode": "browser"})
	if err != nil {
		return OAuthState{}, err
	}
	s.rememberAccount(consumed.ID, accountID)
	return s.withAccount(consumed), nil
}

func (s *OAuthService) OAuthCancel(_ context.Context, sessionID string) error {
	if s == nil || s.Sessions == nil {
		return NewError(CodeUnavailable, "OAuth service is unavailable")
	}
	session, err := s.Sessions.Get(sessionID, "")
	if err != nil {
		return classifyOAuthError(err)
	}
	if err := s.Sessions.Cancel(session.ID, session.ProviderID); err != nil {
		return classifyOAuthError(err)
	}
	return nil
}

func (s *OAuthService) OAuthRefresh(ctx context.Context, input OAuthRefreshInput) (OAuthState, error) {
	if s == nil || s.Refresher == nil {
		return OAuthState{}, NewError(CodeUnavailable, "OAuth refresher is unavailable")
	}
	accountID := strings.TrimSpace(input.AccountID)
	if accountID == "" {
		return OAuthState{}, NewError(CodeInvalidRequest, "accountId is required")
	}
	var tokenSet *accounts.TokenSet
	var err error
	if input.Force {
		tokenSet, err = s.Refresher.ForceRefresh(ctx, accountID)
	} else {
		tokenSet, err = s.Refresher.Current(ctx, accountID)
	}
	if err != nil {
		return OAuthState{}, classifyOAuthError(err)
	}
	if tokenSet != nil {
		tokenSet.Close()
	}
	return OAuthState{AccountID: accountID, Status: "completed"}, nil
}

func (s *OAuthService) OAuthReauthenticate(ctx context.Context, input OAuthRefreshInput) (OAuthState, error) {
	input.Force = true
	return s.OAuthRefresh(ctx, input)
}

func (s *OAuthService) beginPoll(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.polling[id] {
		return false
	}
	s.polling[id] = true
	return true
}

func (s *OAuthService) endPoll(id string) {
	s.mu.Lock()
	delete(s.polling, id)
	s.mu.Unlock()
}

func (s *OAuthService) rememberAccount(sessionID, accountID string) {
	s.mu.Lock()
	s.accountBySession[sessionID] = accountID
	s.mu.Unlock()
}

func (s *OAuthService) withAccount(session flow.Session) OAuthState {
	state := s.state(session)
	s.mu.Lock()
	state.AccountID = s.accountBySession[session.ID]
	s.mu.Unlock()
	return state
}

func (s *OAuthService) state(session flow.Session) OAuthState {
	status := string(session.Status)
	if status == string(flow.StatusPending) {
		status = "pending"
	}
	return OAuthState{
		SessionID:       boundedOAuthValue(session.ID, maxAdminField),
		Status:          boundedOAuthValue(status, 64),
		Flow:            boundedOAuthValue(string(session.Flow), 32),
		URL:             boundedOAuthValue(session.AuthorizationURL, 2048),
		UserCode:        boundedOAuthValue(session.UserCode, maxAdminField),
		VerificationURI: boundedOAuthValue(session.VerificationURI, 2048),
		IntervalSeconds: session.IntervalSeconds,
		ExpiresAt:       session.ExpiresAt.UTC().Format(time.RFC3339),
	}
}

func (s *OAuthService) persistToken(ctx context.Context, providerID string, kind accounts.CredentialKind, tokenSet *accounts.TokenSet, labels map[string]string) (string, error) {
	if tokenSet == nil || !tokenSet.Valid() {
		return "", NewError(CodeInternal, "OAuth token set is invalid")
	}
	accountID, err := randomAccountID()
	if err != nil {
		tokenSet.Close()
		return "", NewError(CodeInternal, "could not allocate account identity").WithCause(err)
	}
	ref, err := accounts.NewReference(accountID)
	if err != nil {
		tokenSet.Close()
		return "", NewError(CodeInternal, "could not allocate credential reference").WithCause(err)
	}
	record := &accounts.OAuthTokenRecord{}
	record.FromTokenSet(accountID, providerID, kind, tokenSet, s.now())
	cfg := &accounts.AccountConfig{ID: accountID, ProviderID: providerID, Kind: kind, Enabled: true, CredentialRef: ref, Labels: boundedLabels(labels)}
	if err := s.Accounts.Put(ctx, cfg); err != nil {
		tokenSet.Close()
		return "", NewError(CodeUnavailable, "could not persist OAuth account").WithCause(err)
	}
	if err := s.Secrets.PutAccess(ctx, accountID, tokenSet.Access); err != nil {
		tokenSet.Access = nil
		tokenSet.Refresh = nil
		_ = s.Accounts.Delete(ctx, accountID)
		return "", NewError(CodeUnavailable, "could not persist OAuth access credential").WithCause(err)
	}
	tokenSet.Access = nil
	if tokenSet.Refresh != nil && !tokenSet.Refresh.IsZero() {
		if err := s.Secrets.PutRefresh(ctx, accountID, tokenSet.Refresh); err != nil {
			tokenSet.Refresh = nil
			_ = s.Secrets.Delete(ctx, accountID)
			_ = s.Accounts.Delete(ctx, accountID)
			return "", NewError(CodeUnavailable, "could not persist OAuth refresh credential").WithCause(err)
		}
		tokenSet.Refresh = nil
	}
	if err := s.Records.Put(ctx, record); err != nil {
		_ = s.Secrets.Delete(ctx, accountID)
		_ = s.Accounts.Delete(ctx, accountID)
		return "", NewError(CodeUnavailable, "could not persist OAuth token metadata").WithCause(err)
	}
	return accountID, nil
}

func (s *OAuthService) importKiroJSON(ctx context.Context, input OAuthStartInput) (OAuthState, error) {
	raw := strings.TrimSpace(input.CredentialJSON)
	if raw == "" || len(raw) > maxOAuthImportBytes {
		return OAuthState{}, NewError(CodeInvalidRequest, "bounded Kiro credential JSON is required")
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return OAuthState{}, NewError(CodeInvalidRequest, "Kiro credential JSON is malformed").WithCause(err)
	}
	access := firstJSONString(value, "access_token", "accessToken")
	refresh := firstJSONString(value, "refresh_token", "refreshToken")
	if access == "" || refresh == "" {
		return OAuthState{}, NewError(CodeInvalidRequest, "Kiro credential JSON requires access and refresh tokens")
	}
	expiresAt := parseJSONExpiry(value, s.now())
	providerAccountID := firstJSONString(value, "profile_arn", "profileArn")
	email := firstJSONString(value, "email", "username", "preferred_username")
	labels := map[string]string{"mode": "manual-json"}
	if profile := firstJSONString(value, "profile_arn", "profileArn"); profile != "" {
		labels["profileArn"] = profile
	}
	if region := firstJSONString(value, "region"); region != "" {
		labels["region"] = region
	}
	tokenSet := &accounts.TokenSet{Access: accounts.NewSecretFromString(access), Refresh: accounts.NewSecretFromString(refresh), Origin: accounts.OriginExternal, ExpiresAt: expiresAt, ProviderAccountID: boundedOAuthValue(providerAccountID, maxOAuthLabelBytes), Email: boundedOAuthValue(email, maxOAuthLabelBytes), Scope: boundedOAuthValue(firstJSONString(value, "scope", "scopes"), maxOAuthLabelBytes)}
	accountID, err := s.persistToken(ctx, drivers.ProviderKiro, accounts.KindOAuth, tokenSet, labels)
	if err != nil {
		return OAuthState{}, err
	}
	return OAuthState{AccountID: accountID, Status: "completed"}, nil
}
func parseKiroCallback(raw string) (string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Scheme, "kiro") || !strings.EqualFold(parsed.Host, "kiro.kiroAgent") || parsed.Path != "/authenticate-success" {
		return "", "", errors.New("callback scheme, host, or path is not allowed")
	}
	if providerError := strings.TrimSpace(parsed.Query().Get("error")); providerError != "" {
		return "", "", errors.New("provider denied authorization")
	}
	code := strings.TrimSpace(parsed.Query().Get("code"))
	state := strings.TrimSpace(parsed.Query().Get("state"))
	if code == "" || state == "" {
		return "", "", errors.New("callback code and state are required")
	}
	return code, state, nil
}

func firstJSONString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if raw, ok := value[key]; ok {
			switch v := raw.(type) {
			case string:
				if text := strings.TrimSpace(v); text != "" {
					return text
				}
			case []any:
				parts := make([]string, 0, len(v))
				for _, item := range v {
					if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
						parts = append(parts, strings.TrimSpace(text))
					}
				}
				if len(parts) > 0 {
					return strings.Join(parts, " ")
				}
			}
		}
	}
	return ""
}

func parseJSONExpiry(value map[string]any, now time.Time) time.Time {
	for _, key := range []string{"expires_at", "expiresAt", "expired"} {
		if text := firstJSONString(value, key); text != "" {
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				return parsed
			}
		}
	}
	for _, key := range []string{"expires_in", "expiresIn"} {
		if raw, ok := value[key].(float64); ok && raw > 0 && raw < 365*24*3600 {
			return now.Add(time.Duration(raw) * time.Second)
		}
	}
	return now.Add(time.Hour)
}

func boundedScopes(scopes []string) []string {
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if text := boundedOAuthValue(scope, 256); text != "" {
			out = append(out, text)
		}
		if len(out) >= 32 {
			break
		}
	}
	return out
}

func boundedLabels(labels map[string]string) map[string]string {
	out := make(map[string]string, len(labels))
	for key, value := range labels {
		key = boundedOAuthValue(key, maxOAuthLabelBytes)
		value = boundedOAuthValue(value, maxOAuthLabelBytes)
		if key != "" && value != "" {
			out[key] = value
		}
	}
	return out
}

func randomAccountID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "oauth-" + base64.RawURLEncoding.EncodeToString(buf), nil
}

func classifyOAuthError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*Error); ok {
		return err
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "expired"):
		return Wrap(CodeUnavailable, "OAuth session expired", err)
	case strings.Contains(message, "mismatch"), strings.Contains(message, "invalid callback"), strings.Contains(message, "required"):
		return Wrap(CodeInvalidRequest, "OAuth request is invalid", err)
	case strings.Contains(message, "unsupported"):
		return Wrap(CodeUnavailable, "OAuth operation is unavailable", err)
	default:
		return Wrap(CodeUnavailable, "OAuth operation failed", err)
	}
}
