// Package flow contains bounded interactive OAuth orchestration primitives.
// It never persists token material or authorization responses.
package flow

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

const (
	DefaultSessionTTL  = 10 * time.Minute
	DefaultMaxSessions = 128
	maxTokenBytes      = 96
)

var (
	ErrSessionNotFound         = errors.New("oauth flow: session not found")
	ErrSessionExpired          = errors.New("oauth flow: session expired")
	ErrSessionConsumed         = errors.New("oauth flow: session already consumed")
	ErrSessionProviderMismatch = errors.New("oauth flow: provider mismatch")
	ErrInvalidCallback         = errors.New("oauth flow: invalid callback")
)

type Status string

const (
	StatusPending   Status = "pending"
	StatusCompleted Status = "completed"
	StatusCancelled Status = "cancelled"
	StatusExpired   Status = "expired"
	StatusDenied    Status = "denied"
)

type Session struct {
	ID               string
	ProviderID       string
	Flow             accounts.OAuthFlowKind
	State            string
	CodeVerifier     string
	AuthorizationURL string
	UserCode         string
	VerificationURI  string
	IntervalSeconds  int
	ExpiresAt        time.Time
	Status           Status
	Consumed         bool
	Code             string
	CallbackState    string
}

type ManagerOptions struct {
	TTL         time.Duration
	MaxSessions int
	Now         func() time.Time
}

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	ttl      time.Duration
	max      int
	now      func() time.Time
}

func NewManager(options ManagerOptions) *Manager {
	ttl := options.TTL
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	max := options.MaxSessions
	if max <= 0 {
		max = DefaultMaxSessions
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Manager{sessions: make(map[string]*Session), ttl: ttl, max: max, now: now}
}

func (m *Manager) Start(providerID string, flow accounts.OAuthFlowKind, authorizationURL, userCode, verificationURI string, intervalSeconds int) (Session, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" || len(providerID) > maxTokenBytes {
		return Session{}, errors.New("oauth flow: provider id is required")
	}
	if flow != accounts.FlowBrowser && flow != accounts.FlowDevice {
		return Session{}, errors.New("oauth flow: unsupported flow")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireLocked()
	if len(m.sessions) >= m.max {
		return Session{}, errors.New("oauth flow: session capacity exceeded")
	}
	id, err := randomToken(24)
	if err != nil {
		return Session{}, err
	}
	state, err := randomToken(32)
	if err != nil {
		return Session{}, err
	}
	verifier, err := randomToken(48)
	if err != nil {
		return Session{}, err
	}
	now := m.now()
	s := &Session{ID: id, ProviderID: providerID, Flow: flow, State: state, CodeVerifier: verifier, AuthorizationURL: bounded(authorizationURL, 2048), UserCode: bounded(userCode, 128), VerificationURI: bounded(verificationURI, 2048), IntervalSeconds: clampInterval(intervalSeconds), ExpiresAt: now.Add(m.ttl), Status: StatusPending}
	m.sessions[id] = s
	return publicCopy(*s), nil
}

// StartFromOAuth stores the state and PKCE verifier returned by a driver.
// The values remain private to the manager; the returned projection is safe
// for an admin response.
func (m *Manager) StartFromOAuth(providerID string, flow accounts.OAuthFlowKind, result accounts.OAuthStartResult) (Session, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" || len(providerID) > maxTokenBytes {
		return Session{}, errors.New("oauth flow: provider id is required")
	}
	if flow != accounts.FlowBrowser && flow != accounts.FlowDevice {
		return Session{}, errors.New("oauth flow: unsupported flow")
	}
	state := bounded(result.State, maxTokenBytes)
	if state == "" {
		var err error
		state, err = randomToken(32)
		if err != nil {
			return Session{}, err
		}
	}
	verifier := bounded(result.CodeVerifier, maxTokenBytes)
	if flow == accounts.FlowBrowser && verifier == "" {
		var err error
		verifier, err = randomToken(48)
		if err != nil {
			return Session{}, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireLocked()
	if len(m.sessions) >= m.max {
		return Session{}, errors.New("oauth flow: session capacity exceeded")
	}
	id, err := randomToken(24)
	if err != nil {
		return Session{}, err
	}
	now := m.now()
	expiresAt := result.ExpiresAt
	if expiresAt.IsZero() || !expiresAt.After(now) || expiresAt.After(now.Add(m.ttl)) {
		expiresAt = now.Add(m.ttl)
	}
	s := &Session{
		ID:               id,
		ProviderID:       providerID,
		Flow:             flow,
		State:            state,
		CodeVerifier:     verifier,
		AuthorizationURL: bounded(result.AuthorizationURL, 2048),
		UserCode:         bounded(result.UserCode, 128),
		VerificationURI:  bounded(result.VerificationURI, 2048),
		IntervalSeconds:  clampInterval(result.IntervalSeconds),
		ExpiresAt:        expiresAt,
		Status:           StatusPending,
	}
	m.sessions[id] = s
	return publicCopy(*s), nil
}

func (m *Manager) Get(id, providerID string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, err
	}
	return publicCopy(*s), nil
}

// StateForDriver returns the private provider state for an active session.
// It is intended only for an injected AuthDriver call and is never serialized.
func (m *Manager) StateForDriver(id, providerID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return "", err
	}
	return s.State, nil
}

// ConsumeCallback validates and consumes a browser callback exactly once.
func (m *Manager) ConsumeCallback(id, providerID, callbackURL string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, err
	}
	if s.Consumed {
		return Session{}, ErrSessionConsumed
	}
	code, state, providerError, err := ParseLoopbackCallback(callbackURL)
	if err != nil || state != s.State {
		return Session{}, ErrInvalidCallback
	}
	if providerError != "" {
		s.Status = StatusDenied
		s.Consumed = true
		return publicCopy(*s), errors.New("oauth flow: provider denied authorization")
	}
	s.Consumed = true
	s.Code = bounded(code, maxTokenBytes)
	s.CallbackState = state
	s.Status = StatusCompleted
	return publicCopy(*s), nil
}

// ConsumeCallbackForExchange validates and consumes a browser callback while
// returning the private verifier needed by the driver. The exchange input
// remains in caller memory only and is never part of the public Session.
func (m *Manager) ConsumeCallbackForExchange(id, providerID, callbackURL, redirectURI string) (Session, accounts.OAuthExchangeInput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, accounts.OAuthExchangeInput{}, err
	}
	if s.Consumed {
		return Session{}, accounts.OAuthExchangeInput{}, ErrSessionConsumed
	}
	code, state, providerError, err := ParseLoopbackCallback(callbackURL)
	if err != nil || state != s.State || code == "" {
		return Session{}, accounts.OAuthExchangeInput{}, ErrInvalidCallback
	}
	if providerError != "" {
		s.Status = StatusDenied
		s.Consumed = true
		return publicCopy(*s), accounts.OAuthExchangeInput{}, errors.New("oauth flow: provider denied authorization")
	}
	s.Consumed = true
	s.Code = bounded(code, maxTokenBytes)
	s.CallbackState = state
	s.Status = StatusCompleted
	return publicCopy(*s), accounts.OAuthExchangeInput{
		ProviderID:   providerID,
		Code:         s.Code,
		State:        s.State,
		RedirectURI:  redirectURI,
		CodeVerifier: s.CodeVerifier,
	}, nil
}

// ConsumeCodeForExchange consumes a validated code/state pair for providers
// whose registered callback uses a custom scheme rather than loopback HTTP.
// The caller must validate the provider-specific callback URI before calling.
func (m *Manager) ConsumeCodeForExchange(id, providerID, code, state, redirectURI string) (Session, accounts.OAuthExchangeInput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, accounts.OAuthExchangeInput{}, err
	}
	if s.Consumed || strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" || state != s.State {
		return Session{}, accounts.OAuthExchangeInput{}, ErrInvalidCallback
	}
	s.Consumed = true
	s.Code = bounded(code, maxTokenBytes)
	s.CallbackState = state
	s.Status = StatusCompleted
	return publicCopy(*s), accounts.OAuthExchangeInput{
		ProviderID:   providerID,
		Code:         s.Code,
		State:        s.State,
		RedirectURI:  redirectURI,
		CodeVerifier: s.CodeVerifier,
	}, nil
}

func (m *Manager) CompleteDevice(id, providerID string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, err
	}
	if s.Consumed {
		return Session{}, ErrSessionConsumed
	}
	s.Consumed = true
	s.Status = StatusCompleted
	return publicCopy(*s), nil
}

// Fail marks a pending session with a terminal provider outcome.
func (m *Manager) Fail(id, providerID string, status Status) (Session, error) {
	if status != StatusExpired && status != StatusDenied {
		return Session{}, errors.New("oauth flow: invalid terminal status")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return Session{}, err
	}
	s.Consumed = true
	s.Status = status
	return publicCopy(*s), nil
}

func (m *Manager) Cancel(id, providerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.lookupLocked(id, providerID)
	if err != nil {
		return err
	}
	s.Consumed = true
	s.Status = StatusCancelled
	return nil
}

func (m *Manager) Remove(id string) { m.mu.Lock(); delete(m.sessions, id); m.mu.Unlock() }

func (m *Manager) lookupLocked(id, providerID string) (*Session, error) {
	id = strings.TrimSpace(id)
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	if providerID != "" && s.ProviderID != strings.TrimSpace(providerID) {
		return nil, ErrSessionProviderMismatch
	}
	if !s.ExpiresAt.After(m.now()) && s.Status == StatusPending {
		s.Status = StatusExpired
		s.Consumed = true
		return nil, ErrSessionExpired
	}
	return s, nil
}
func (m *Manager) expireLocked() {
	now := m.now()
	for _, s := range m.sessions {
		if s.Status == StatusPending && !s.ExpiresAt.After(now) {
			s.Status = StatusExpired
			s.Consumed = true
		}
	}
}

func publicCopy(s Session) Session {
	s.State = ""
	s.CodeVerifier = ""
	s.Code = ""
	s.CallbackState = ""
	return s
}
func bounded(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max]
	}
	return s
}
func clampInterval(v int) int {
	if v < 1 {
		return 5
	}
	if v > 300 {
		return 300
	}
	return v
}
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// IDs provides deterministic diagnostics without exposing state or codes.
func (m *Manager) IDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
