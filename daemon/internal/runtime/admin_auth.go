package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	dbmodels "github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
	adminserver "github.com/cartethyia/daemon/internal/server/admin"
)

// Console session auth.
//
// Passwords verify as argon2id PHC strings against the settings record, and
// sessions are stateless HMAC-SHA256 tokens (compact JWT shape) bound to the
// password version at issue time — bumping the password invalidates every
// outstanding token without any server-side session store. OAuth lifecycle
// methods delegate to the composed OAuth service through embedding.

const (
	consoleSessionCookieName = "cartethyia_session"
	consoleSessionUser       = "admin"
	consoleSessionScope      = "admin:*"
	sessionTokenHeaderTyp    = "JWT"
	sessionTokenAlg          = "HS256"
	sessionTokenRole         = "admin"

	defaultSessionTTL    = 24 * time.Hour
	rememberSessionTTL   = 7 * 24 * time.Hour
	maxSessionTTL        = 7 * 24 * time.Hour
	maxSessionTokenBytes = 2048
	minJWTSecretBytes    = 32

	consoleArgon2MemoryKiB   = 19_456
	consoleArgon2TimeCost    = 2
	consoleArgon2Parallelism = 1
	consoleArgon2SaltLength  = 16
	consoleArgon2KeyLength   = 32

	loginRateWindow      = 5 * time.Minute
	loginRateMaxFailures = 10
	loginLimiterCapacity = 8_192

	settingsSnapshotTTL = 15 * time.Second
	maxBootstrapBytes   = 256
)

// consoleSettingsStore is the settings surface console auth depends on.
type consoleSettingsStore interface {
	Ensure(ctx context.Context) (dbmodels.Settings, error)
	Get(ctx context.Context) (dbmodels.Settings, error)
	SetPasswordHash(ctx context.Context, hash string) error
	RotateJWTSecret(ctx context.Context, secret string) error
}

type sessionAuthService struct {
	adminserver.OAuthLifecycleService

	settings          consoleSettingsStore
	bootstrapPassword string
	now               func() time.Time

	limiter        *consoleLoginLimiter
	ensureMu       sync.Mutex
	passwordSeeded bool
	snapshot       dbmodels.Settings
	snapAt         time.Time
}

// newSessionAuthService builds the console session service. repository may be
// nil, in which case every call fails closed. bootstrapPassword seeds the
// console password on first use when no hash is stored yet.
func newSessionAuthService(repository *dbrepositories.BunSettingsRepository, oauth adminserver.OAuthLifecycleService, bootstrapPassword string) *sessionAuthService {
	var store consoleSettingsStore
	if repository != nil {
		store = repository
	}
	return &sessionAuthService{
		OAuthLifecycleService: oauth,
		settings:              store,
		bootstrapPassword:     strings.TrimSpace(bootstrapPassword),
		now:                   time.Now,
		limiter:               newConsoleLoginLimiter(loginRateWindow, loginRateMaxFailures, time.Now),
	}
}

// Login verifies the console password, applies a bounded per-IP failure
// limiter, and issues a signed session token in the cartethyia_session
// cookie.
func (s *sessionAuthService) Login(ctx context.Context, input adminserver.LoginInput, request adminserver.AuthRequest) (adminserver.LoginResult, error) {
	if s == nil || s.settings == nil {
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeAdminUnavailable, "console auth is not configured")
	}
	ip := boundedLoginKey(request.IP)
	if wait, limited := s.limiter.retryAfter(ip); limited {
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeRateLimited, fmt.Sprintf("too many failed attempts; retry after %ds", int(wait.Seconds())+1))
	}

	settings, err := s.currentSettings(ctx)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "console settings are unavailable: "+err.Error(), err)
	}
	settings, err = s.ensureConsoleBootstrap(ctx, settings)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "console bootstrap is unavailable", err)
	}
	if strings.TrimSpace(settings.PasswordHash) == "" {
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "console password is not initialized")
	}
	if !verifyConsolePassword(settings.PasswordHash, input.Password) {
		s.limiter.recordFailure(ip)
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "invalid credentials")
	}
	s.limiter.recordSuccess(ip)

	secret, err := s.ensureSessionSecret(ctx, settings)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "session signing key is unavailable", err)
	}

	ttl := defaultSessionTTL
	if input.Remember {
		ttl = rememberSessionTTL
	}
	token, jti, issued, expires, err := signSessionToken(secret, settings.PasswordVersion, ttl, s.now)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "session token signing failed", err)
	}
	maxAge := int(ttl / time.Second)
	return adminserver.LoginResult{
		Session: adminserver.Session{
			ID:        jti,
			User:      consoleSessionUser,
			Scopes:    []string{consoleSessionScope},
			CreatedAt: issued.UTC().Format(time.RFC3339),
			ExpiresAt: expires.UTC().Format(time.RFC3339),
		},
		SetCookie: buildSessionCookie(token, maxAge, requestSecure(request)),
		MaxAge:    maxAge,
	}, nil
}

// Logout is stateless: tokens carry their own expiry and the transport layer
// clears the session cookie.
func (s *sessionAuthService) Logout(context.Context, string) error { return nil }

// Current validates a session token (signature, expiry, password version)
// and returns the console session view.
func (s *sessionAuthService) Current(ctx context.Context, sessionID string) (adminserver.Session, error) {
	if s == nil || s.settings == nil {
		return adminserver.Session{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "authentication required")
	}
	settings, err := s.currentSettings(ctx)
	if err != nil {
		return adminserver.Session{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "console settings are unavailable: "+err.Error(), err)
	}
	secret, err := s.ensureSessionSecret(ctx, settings)
	if err != nil {
		return adminserver.Session{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "session signing key is unavailable", err)
	}
	claims, err := verifySessionToken(sessionID, secret, settings.PasswordVersion, s.now)
	if err != nil {
		return adminserver.Session{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "authentication required")
	}
	return adminserver.Session{
		ID:        claims.JTI,
		User:      consoleSessionUser,
		Scopes:    []string{consoleSessionScope},
		CreatedAt: time.Unix(claims.IAT, 0).UTC().Format(time.RFC3339),
		ExpiresAt: time.Unix(claims.EXP, 0).UTC().Format(time.RFC3339),
	}, nil
}

// Refresh validates the presented session token (signature, expiry,
// password version) and re-issues a freshly signed token that carries the
// same subject and password-version binding with a rotated expiry. The new
// token is delivered through a new cartethyia_session cookie using the
// exact cookie contract Login applies; the response body keeps the GET
// session shape.
func (s *sessionAuthService) Refresh(ctx context.Context, sessionID string, request adminserver.AuthRequest) (adminserver.LoginResult, error) {
	if s == nil || s.settings == nil {
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "authentication required")
	}
	settings, err := s.currentSettings(ctx)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "console settings are unavailable: "+err.Error(), err)
	}
	secret, err := s.ensureSessionSecret(ctx, settings)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "session signing key is unavailable", err)
	}
	claims, err := verifySessionToken(sessionID, secret, settings.PasswordVersion, s.now)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.NewError(adminserver.CodeAdminAuthentication, "authentication required")
	}
	// Preserve the original session's lifetime so a remember-me refresh
	// stays a remember-me session; verifySessionToken bounds it to
	// maxSessionTTL and a positive window already.
	ttl := time.Duration(claims.EXP-claims.IAT) * time.Second
	token, jti, issued, expires, err := signSessionToken(secret, claims.PV, ttl, s.now)
	if err != nil {
		return adminserver.LoginResult{}, adminserver.Wrap(adminserver.CodeAdminUnavailable, "session token signing failed", err)
	}
	maxAge := int(ttl / time.Second)
	return adminserver.LoginResult{
		Session: adminserver.Session{
			ID:        jti,
			User:      consoleSessionUser,
			Scopes:    []string{consoleSessionScope},
			CreatedAt: issued.UTC().Format(time.RFC3339),
			ExpiresAt: expires.UTC().Format(time.RFC3339),
		},
		SetCookie: buildSessionCookie(token, maxAge, requestSecure(request)),
		MaxAge:    maxAge,
	}, nil
}

// currentSettings reads the settings record through a short-lived snapshot
// cache so the per-request authorizer does not hammer the database. The
// cache key covers both mutation timestamps and password-version bumps.
func (s *sessionAuthService) currentSettings(ctx context.Context) (dbmodels.Settings, error) {
	now := s.now()
	s.ensureMu.Lock()
	if !s.snapAt.IsZero() && s.snapAt.Add(settingsSnapshotTTL).After(now) {
		cached := s.snapshot
		s.ensureMu.Unlock()
		return cached, nil
	}
	s.ensureMu.Unlock()

	if _, err := s.settings.Ensure(ctx); err != nil {
		return dbmodels.Settings{}, err
	}
	fresh, err := s.settings.Get(ctx)
	if err != nil {
		return dbmodels.Settings{}, err
	}

	s.ensureMu.Lock()
	s.snapshot = fresh
	s.snapAt = now
	s.ensureMu.Unlock()
	return fresh, nil
}

// ensureConsoleBootstrap seeds the bootstrap password (first production
// start with CONSOLE_PASSWORD set) exactly once per process.
func (s *sessionAuthService) ensureConsoleBootstrap(ctx context.Context, settings dbmodels.Settings) (dbmodels.Settings, error) {
	s.ensureMu.Lock()
	defer s.ensureMu.Unlock()
	if s.passwordSeeded {
		return settings, nil
	}
	s.passwordSeeded = true
	bs := s.bootstrapPassword
	if bs == "" || len(bs) > maxBootstrapBytes || strings.TrimSpace(settings.PasswordHash) != "" {
		return settings, nil
	}
	hash, err := hashConsolePassword(bs)
	if err != nil {
		return settings, err
	}
	if err := s.settings.SetPasswordHash(ctx, hash); err != nil {
		return settings, err
	}
	settings.PasswordHash = hash
	s.snapshot = settings
	return settings, nil
}

// ensureSessionSecret lazily provisions a JWT signing secret when the
// settings record does not carry one yet.
func (s *sessionAuthService) ensureSessionSecret(ctx context.Context, settings dbmodels.Settings) (string, error) {
	s.ensureMu.Lock()
	defer s.ensureMu.Unlock()
	if secret := strings.TrimSpace(settings.JWTSecret); len(secret) >= minJWTSecretBytes {
		return secret, nil
	}
	secret, err := randomHex(32)
	if err != nil {
		return "", err
	}
	if err := s.settings.RotateJWTSecret(ctx, secret); err != nil {
		return "", err
	}
	settings.JWTSecret = secret
	s.snapshot = settings
	return secret, nil
}

func requestSecure(request adminserver.AuthRequest) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(request.BaseURL)), "https://")
}

func buildSessionCookie(token string, maxAge int, secure bool) string {
	var b strings.Builder
	b.WriteString(consoleSessionCookieName)
	b.WriteString("=")
	b.WriteString(token)
	b.WriteString("; Path=/; HttpOnly; SameSite=Strict; Max-Age=")
	b.WriteString(strconv.Itoa(maxAge))
	if secure {
		b.WriteString("; Secure")
	}
	return b.String()
}

func boundedLoginKey(ip string) string {
	key := strings.TrimSpace(ip)
	if key == "" {
		key = "unknown"
	}
	if len(key) > 64 {
		key = key[:64]
	}
	return key
}

// ---------------------------------------------------------------------------
// Session token (compact HMAC-SHA256 JWT shape)
// ---------------------------------------------------------------------------

type sessionClaims struct {
	Role string `json:"role"`
	PV   int    `json:"pv"`
	JTI  string `json:"jti"`
	IAT  int64  `json:"iat"`
	EXP  int64  `json:"exp"`
}

type sessionTokenHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

func b64urlEncode(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }
func b64urlDecode(part string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(part, "="))
}

func signSessionToken(secret string, passwordVersion int, ttl time.Duration, now func() time.Time) (token, jti string, issued, expires time.Time, err error) {
	if len(strings.TrimSpace(secret)) < minJWTSecretBytes {
		return "", "", time.Time{}, time.Time{}, errors.New("session secret is too short")
	}
	if passwordVersion < 1 || ttl <= 0 || ttl > maxSessionTTL {
		return "", "", time.Time{}, time.Time{}, errors.New("session token parameters out of range")
	}
	jtiRaw := make([]byte, 16)
	if _, err := rand.Read(jtiRaw); err != nil {
		return "", "", time.Time{}, time.Time{}, err
	}
	jti = hex.EncodeToString(jtiRaw)
	issued = now().UTC()
	expires = issued.Add(ttl)
	header, err := json.Marshal(sessionTokenHeader{Alg: sessionTokenAlg, Typ: sessionTokenHeaderTyp})
	if err != nil {
		return "", "", time.Time{}, time.Time{}, err
	}
	payload, err := json.Marshal(sessionClaims{
		Role: sessionTokenRole,
		PV:   passwordVersion,
		JTI:  jti,
		IAT:  issued.Unix(),
		EXP:  expires.Unix(),
	})
	if err != nil {
		return "", "", time.Time{}, time.Time{}, err
	}
	signing := b64urlEncode(header) + "." + b64urlEncode(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	return signing + "." + b64urlEncode(mac.Sum(nil)), jti, issued, expires, nil
}

func verifySessionToken(token, secret string, expectedPasswordVersion int, now func() time.Time) (sessionClaims, error) {
	if len(token) == 0 || len(token) > maxSessionTokenBytes || len(strings.TrimSpace(secret)) < minJWTSecretBytes {
		return sessionClaims{}, errors.New("malformed session token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return sessionClaims{}, errors.New("malformed session token")
	}
	headerRaw, err := b64urlDecode(parts[0])
	if err != nil {
		return sessionClaims{}, errors.New("malformed session token")
	}
	var header sessionTokenHeader
	if err := json.Unmarshal(headerRaw, &header); err != nil || header.Alg != sessionTokenAlg || header.Typ != sessionTokenHeaderTyp {
		return sessionClaims{}, errors.New("malformed session token")
	}
	payloadRaw, err := b64urlDecode(parts[1])
	if err != nil {
		return sessionClaims{}, errors.New("malformed session token")
	}
	var claims sessionClaims
	if err := json.Unmarshal(payloadRaw, &claims); err != nil {
		return sessionClaims{}, errors.New("malformed session token")
	}
	if claims.Role != sessionTokenRole || claims.JTI == "" || claims.PV < 1 {
		return sessionClaims{}, errors.New("malformed session token")
	}
	if claims.EXP <= claims.IAT || claims.EXP-claims.IAT > int64(maxSessionTTL/time.Second) {
		return sessionClaims{}, errors.New("malformed session token")
	}
	given, err := b64urlDecode(parts[2])
	if err != nil {
		return sessionClaims{}, errors.New("malformed session token")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if subtle.ConstantTimeCompare(given, mac.Sum(nil)) != 1 {
		return sessionClaims{}, errors.New("session signature mismatch")
	}
	if now().Unix() >= claims.EXP {
		return sessionClaims{}, errors.New("session token expired")
	}
	if claims.PV != expectedPasswordVersion {
		return sessionClaims{}, errors.New("session token password version mismatch")
	}
	return claims, nil
}

// ---------------------------------------------------------------------------
// argon2id PHC password hashing (Bun-compatible parameters)
// ---------------------------------------------------------------------------

func verifyConsolePassword(phc, password string) bool {
	fields := strings.Split(phc, "$")
	if len(fields) != 6 || fields[0] != "" || fields[1] != "argon2id" {
		return false
	}
	if !strings.HasPrefix(fields[2], "v=") {
		return false
	}
	version, err := strconv.Atoi(strings.TrimPrefix(fields[2], "v="))
	if err != nil || version != 19 {
		return false
	}
	var memory, timeCost, parallelism int
	for _, param := range strings.Split(fields[3], ",") {
		value := ""
		switch {
		case strings.HasPrefix(param, "m="):
			value = strings.TrimPrefix(param, "m=")
			memory, _ = strconv.Atoi(value)
		case strings.HasPrefix(param, "t="):
			value = strings.TrimPrefix(param, "t=")
			timeCost, _ = strconv.Atoi(value)
		case strings.HasPrefix(param, "p="):
			value = strings.TrimPrefix(param, "p=")
			parallelism, _ = strconv.Atoi(value)
		}
	}
	if memory <= 0 || memory > 1<<22 || timeCost <= 0 || timeCost > 16 || parallelism <= 0 || parallelism > 8 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(fields[4], "="))
	if err != nil || len(salt) == 0 || len(salt) > 128 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(fields[5], "="))
	if err != nil || len(want) == 0 || len(want) > 256 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, uint32(timeCost), uint32(memory), uint8(parallelism), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func hashConsolePassword(password string) (string, error) {
	if password == "" {
		return "", errors.New("console password must not be empty")
	}
	salt := make([]byte, consoleArgon2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, consoleArgon2TimeCost, consoleArgon2MemoryKiB, consoleArgon2Parallelism, consoleArgon2KeyLength)
	return fmt.Sprintf(
		"$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		consoleArgon2MemoryKiB, consoleArgon2TimeCost, consoleArgon2Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func randomHex(byteLength int) (string, error) {
	raw := make([]byte, byteLength)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// ---------------------------------------------------------------------------
// Bounded per-IP login failure limiter
// ---------------------------------------------------------------------------

type consoleLoginLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	now    func() time.Time
	failed map[string][]time.Time
}

func newConsoleLoginLimiter(window time.Duration, max int, now func() time.Time) *consoleLoginLimiter {
	return &consoleLoginLimiter{window: window, max: max, now: now, failed: make(map[string][]time.Time)}
}

func (l *consoleLoginLimiter) retryAfter(key string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-l.window)
	failures := l.prune(key, cutoff)
	if len(failures) < l.max {
		return 0, false
	}
	return failures[0].Add(l.window).Sub(l.now()), true
}

func (l *consoleLoginLimiter) recordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-l.window)
	l.failed[key] = append(l.prune(key, cutoff), l.now())
	if len(l.failed) > loginLimiterCapacity {
		for k := range l.failed {
			delete(l.failed, k)
			if len(l.failed) <= loginLimiterCapacity/2 {
				break
			}
		}
	}
}

func (l *consoleLoginLimiter) recordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failed, key)
}

func (l *consoleLoginLimiter) prune(key string, cutoff time.Time) []time.Time {
	failures := l.failed[key]
	kept := failures[:0]
	for _, at := range failures {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) == 0 {
		delete(l.failed, key)
		return nil
	}
	l.failed[key] = kept
	return kept
}
