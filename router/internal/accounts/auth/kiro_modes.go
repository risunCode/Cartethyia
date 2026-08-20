package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

const kiroSocialRedirectURI = "kiro://kiro.kiroAgent/authenticate-success"

// SocialStarter is an additive capability used by the Kiro Google/GitHub
// browser mode. It does not alter the provider-neutral AuthDriver contract.
type SocialStarter interface {
	StartSocial(context.Context, string, string) (*OAuthStartResult, error)
}

// KiroDriver adds the documented AWS OIDC JSON wire format and Kiro social
// callback exchange to the shared bounded HTTP driver.
type KiroDriver struct {
	*HTTPDriver
}

func (d *KiroDriver) Start(ctx context.Context, input OAuthStartInput) (*OAuthStartResult, error) {
	if d.cfg.KiroAWS && input.Flow == FlowDevice {
		mode := strings.ToLower(strings.TrimSpace(input.AWSMode))
		if mode != "" && mode != "builder-id" && mode != "idc" {
			return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro AWS mode must be builder-id or idc"))
		}
		return d.startAWS(ctx, input)
	}
	return d.HTTPDriver.Start(ctx, input)
}

func (d *KiroDriver) StartSocial(_ context.Context, provider, _ string) (*OAuthStartResult, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider != "google" && provider != "github" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro social provider is unsupported"))
	}
	verifier, err := randomString(48)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	state, err := randomString(32)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	challenge := pkceChallenge(verifier)
	endpoint := d.cfg.KiroSocialAuthorize
	if endpoint == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro social authorization endpoint is not configured"))
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro social authorization endpoint is invalid"))
	}
	q := u.Query()
	idp := "Github"
	if provider == "google" {
		idp = "Google"
	}
	q.Set("idp", idp)
	q.Set("redirect_uri", kiroSocialRedirectURI)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("prompt", "select_account")
	u.RawQuery = q.Encode()
	d.mu.Lock()
	d.states[state] = tokenState{verifier: verifier, providerID: ProviderKiro, mode: "social"}
	d.mu.Unlock()
	return &OAuthStartResult{AuthorizationURL: u.String(), State: state, CodeVerifier: verifier, ExpiresAt: d.now().Add(10 * time.Minute), Flow: FlowBrowser}, nil
}

func (d *KiroDriver) Exchange(ctx context.Context, input OAuthExchangeInput) (*TokenSet, error) {
	d.mu.Lock()
	st, ok := d.states[input.State]
	d.mu.Unlock()
	if ok && st.mode == "social" {
		if strings.TrimSpace(input.Code) == "" {
			return nil, d.wrap(ErrKindInvalidRequest, errors.New("authorization code is required"))
		}
		body, err := json.Marshal(map[string]string{"code": input.Code, "code_verifier": input.CodeVerifier, "redirect_uri": kiroSocialRedirectURI})
		if err != nil {
			return nil, d.wrap(ErrKindUnknown, err)
		}
		result, err := d.requestResult(ctx, "POST", d.cfg.KiroSocialToken, "application/json", body)
		if err != nil {
			return nil, err
		}
		if !result.ok {
			return nil, d.httpError(result.status, firstString(result.body, "error", "code"))
		}
		// Normalize Kiro's camelCase response into the shared token parser.
		if value := firstString(result.body, "accessToken"); value != "" {
			result.body["access_token"] = value
		}
		if value := firstString(result.body, "refreshToken"); value != "" {
			result.body["refresh_token"] = value
		}
		if value := firstString(result.body, "profileArn"); value != "" {
			result.body["profile_arn"] = value
		}
		if value := intField(result.body, "expiresIn"); value > 0 {
			result.body["expires_in"] = value
		}
		ts, err := d.tokenSet(result.body, OriginOAuth, true)
		if err == nil {
			d.mu.Lock()
			d.deleteStateLocked(input.State)
			d.mu.Unlock()
		}
		return ts, err
	}
	return d.HTTPDriver.Exchange(ctx, input)
}

func (d *KiroDriver) Poll(ctx context.Context, state string) (*OAuthPollResult, error) {
	if !d.cfg.KiroAWS {
		return d.HTTPDriver.Poll(ctx, state)
	}
	d.mu.Lock()
	st, ok := d.states[strings.TrimSpace(state)]
	deviceCode := ""
	clientSecret := ""
	if ok {
		if st.deviceCode != nil {
			deviceCode = st.deviceCode.RevealString()
		}
		if st.clientSecret != nil {
			clientSecret = st.clientSecret.RevealString()
		}
	}
	d.mu.Unlock()
	if !ok || deviceCode == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro device session not found"))
	}
	if !st.expiresAt.IsZero() && !st.expiresAt.After(d.now()) {
		return &OAuthPollResult{Status: PollExpired}, nil
	}
	payload := map[string]string{"clientId": st.clientID, "clientSecret": clientSecret, "deviceCode": deviceCode, "grantType": "urn:ietf:params:oauth:grant-type:device_code"}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	result, err := d.requestResult(ctx, "POST", d.cfg.Endpoints.Token, "application/json", body)
	if err != nil {
		return nil, err
	}
	if !result.ok || firstString(result.body, "error") != "" {
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
		default:
			return nil, d.httpError(result.status, code)
		}
	}
	if value := firstString(result.body, "accessToken"); value != "" {
		result.body["access_token"] = value
	}
	if value := firstString(result.body, "refreshToken"); value != "" {
		result.body["refresh_token"] = value
	}
	if value := firstString(result.body, "profileArn"); value != "" {
		result.body["profile_arn"] = value
	}
	if value := intField(result.body, "expiresIn"); value > 0 {
		result.body["expires_in"] = value
	}
	ts, err := d.tokenSet(result.body, OriginOAuthDevice, true)
	if err != nil {
		return nil, err
	}
	ts.ProviderAccountID = firstString(result.body, "profile_arn", "profileArn", "account_id", "sub")
	d.mu.Lock()
	d.deleteStateLocked(state)
	d.mu.Unlock()
	return &OAuthPollResult{Status: PollCompleted, TokenSet: ts}, nil
}

func (d *KiroDriver) startAWS(ctx context.Context, input OAuthStartInput) (*OAuthStartResult, error) {
	registerEndpoint := strings.Replace(d.cfg.Endpoints.Device, "/device_authorization", "/client/register", 1)
	startURL := d.cfg.KiroAWSStartURL
	if strings.TrimSpace(input.AWSStartURL) != "" {
		startURL = strings.TrimSpace(input.AWSStartURL)
	}
	registerPayload := map[string]any{"clientName": d.cfg.KiroAWSClientName, "clientType": d.cfg.KiroAWSClientType, "scopes": d.cfg.Scopes, "grantTypes": d.cfg.KiroAWSGrantTypes, "issuerUrl": d.cfg.KiroAWSIssuerURL}
	body, err := json.Marshal(registerPayload)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	registered, err := d.requestResult(ctx, "POST", registerEndpoint, "application/json", body)
	if err != nil {
		return nil, err
	}
	if !registered.ok {
		return nil, d.httpError(registered.status, firstString(registered.body, "error", "code"))
	}
	clientID := firstString(registered.body, "clientId", "client_id")
	clientSecret := firstString(registered.body, "clientSecret", "client_secret")
	if clientID == "" || clientSecret == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro client registration response is incomplete"))
	}
	devicePayload, err := json.Marshal(map[string]string{"clientId": clientID, "clientSecret": clientSecret, "startUrl": startURL})
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	device, err := d.requestResult(ctx, "POST", d.cfg.Endpoints.Device, "application/json", devicePayload)
	if err != nil {
		return nil, err
	}
	if !device.ok {
		return nil, d.httpError(device.status, firstString(device.body, "error", "code"))
	}
	deviceCode := firstString(device.body, "deviceCode", "device_code")
	if deviceCode == "" {
		return nil, d.wrap(ErrKindInvalidRequest, errors.New("Kiro device response missing device code"))
	}
	expires := intField(device.body, "expiresIn")
	if expires <= 0 || expires > 3600 {
		expires = 900
	}
	interval := intField(device.body, "interval")
	if interval < 1 || interval > 300 {
		interval = 5
	}
	state, err := randomString(32)
	if err != nil {
		return nil, d.wrap(ErrKindUnknown, err)
	}
	d.mu.Lock()
	d.states[state] = tokenState{providerID: ProviderKiro, deviceCode: NewSecretFromString(deviceCode), clientID: clientID, clientSecret: NewSecretFromString(clientSecret), expiresAt: d.now().Add(time.Duration(expires) * time.Second), mode: "aws"}
	d.mu.Unlock()
	return &OAuthStartResult{State: state, UserCode: bounded(firstString(device.body, "userCode", "user_code"), 128), VerificationURI: bounded(firstString(device.body, "verificationUri", "verification_uri", "verificationUrl"), 2048), IntervalSeconds: interval, ExpiresAt: d.now().Add(time.Duration(expires) * time.Second), Flow: FlowDevice}, nil
}
