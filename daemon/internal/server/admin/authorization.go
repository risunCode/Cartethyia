package admin

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

const (
	CodeAdminAuthentication ErrorCode = "admin.authentication"
	CodeAdminForbidden      ErrorCode = "admin.forbidden"
	CodeAdminInvalidRequest ErrorCode = "admin.invalid_request"
	CodeAdminUnavailable    ErrorCode = "admin.unavailable"
)

// AdminScope is the permission required by an admin route. Scope values are
// deliberately stable so policy stores and dashboard clients do not need to
// understand route names.
type AdminScope string

const (
	ScopeAuth      AdminScope = "admin:auth"
	ScopeHealth    AdminScope = "admin:health"
	ScopeCatalog   AdminScope = "admin:catalog"
	ScopeAccounts  AdminScope = "admin:accounts"
	ScopeKeys      AdminScope = "admin:keys"
	ScopeCache     AdminScope = "admin:cache"
	ScopeUsage     AdminScope = "admin:usage"
	ScopeBackups   AdminScope = "admin:backups"
	ScopeLifecycle AdminScope = "admin:lifecycle"
	ScopeConfig    AdminScope = "admin:config"
)

// AdminActor is the redacted identity attached to an authenticated request.
// It is also the only actor data accepted by the audit boundary.
type AdminActor struct {
	ID string
}

// AdminAuthorizer resolves a session and checks one scope. Authentication and
// policy remain owned by the injected service; the HTTP layer only composes it.
type AdminAuthorizer interface {
	Authorize(ctx context.Context, sessionID string, scope AdminScope) (AdminActor, error)
}

// AuditEvent is the bounded, operator-safe record emitted for admin actions.
type AuditEvent struct {
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Scope  string `json:"scope"`
	Path   string `json:"path"`
	Method string `json:"method"`
	Result string `json:"result"`
	Status int    `json:"status"`
}

// AuditService persists or forwards bounded audit events. Implementations must
// not add request bodies, credentials, provider headers, or raw responses.
type AuditService interface {
	Emit(ctx context.Context, event AuditEvent) error
}

// GenerationPublisher publishes invalidation only after the service operation
// has returned success (which is the service commit boundary).
type GenerationPublisher interface {
	Publish(ctx context.Context, scope string) error
}

// sessionAuthorizer adapts the existing AuthService session boundary to the
// scoped middleware; it does not create a second credential or persistence path.
type sessionAuthorizer struct{ auth AuthService }

func (a sessionAuthorizer) Authorize(ctx context.Context, sessionID string, scope AdminScope) (AdminActor, error) {
	if a.auth == nil || strings.TrimSpace(sessionID) == "" {
		return AdminActor{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	session, err := a.auth.Current(ctx, sessionID)
	if err != nil {
		return AdminActor{}, NewError(CodeAdminAuthentication, "invalid session").WithCause(err)
	}
	if !hasScope(session.Scopes, scope) {
		return AdminActor{}, NewError(CodeAdminForbidden, "admin scope denied")
	}
	return AdminActor{ID: session.User}, nil
}

func hasScope(scopes []string, wanted AdminScope) bool {
	for _, raw := range scopes {
		s := strings.TrimSpace(strings.ToLower(raw))
		if s == "*" || s == "admin:*" || s == "admin" || s == strings.ToLower(string(wanted)) {
			return true
		}
	}
	return false
}

func adminScopeForPath(path string) AdminScope {
	switch {
	case strings.HasPrefix(path, "/console/auth/"):
		return ScopeAuth
	case strings.HasPrefix(path, "/console/accounts"), strings.HasPrefix(path, "/console/providers/"):
		return ScopeAccounts
	case strings.HasPrefix(path, "/console/keys"):
		return ScopeKeys
	case strings.HasPrefix(path, "/console/proxies"):
		return ScopeConfig
	case strings.HasPrefix(path, "/console/custom-providers"):
		return ScopeConfig
	case strings.HasPrefix(path, "/console/proxy-settings"), strings.HasPrefix(path, "/console/settings"):
		return ScopeConfig
	case strings.HasPrefix(path, "/console/backups"):
		return ScopeBackups
	case strings.HasPrefix(path, "/console/telemetry"),
		strings.HasPrefix(path, "/console/logs"):
		return ScopeUsage
	case strings.HasPrefix(path, "/console/web-request"):
		return ScopeHealth
	case strings.HasPrefix(path, "/console/catalog/"):
		return ScopeCatalog
	case strings.HasPrefix(path, "/console/tools/cache"):
		return ScopeCache
	case strings.HasPrefix(path, "/console/tools/restart"):
		return ScopeLifecycle
	case strings.HasPrefix(path, "/console/tools"):
		return ScopeHealth
	case strings.HasPrefix(path, "/console/dashboard"):
		return ScopeHealth
	default:
		return ScopeHealth
	}
}

func isLoginPath(r *http.Request) bool {
	return r != nil && r.Method == http.MethodPost && r.URL.Path == "/console/auth/login"
}

// scopedAdmin wraps all registered admin routes. Login is the sole unauthenticated
// route; every other route must carry a valid session and explicit scope.
func scopedAdmin(services Services, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isLoginPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		authorizer := services.Authorizer
		if authorizer == nil {
			authorizer = sessionAuthorizer{auth: services.Auth}
		}
		actor, err := authorizer.Authorize(r.Context(), readSessionID(r), adminScopeForPath(r.URL.Path))
		if err != nil {
			if services.Audit != nil && isMutationMethod(r.Method) {
				_ = services.Audit.Emit(r.Context(), AuditEvent{
					Action: boundedAuditField(strings.ToLower(r.Method) + " " + r.URL.Path),
					Scope:  boundedAuditField(string(adminScopeForPath(r.URL.Path))),
					Path:   boundedAuditField(r.URL.Path),
					Method: boundedAuditField(r.Method),
					Result: "denied",
					Status: statusForAdminError(err),
				})
			}
			WriteError(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey{}, actor)
		rw := &auditResponseWriter{ResponseWriter: w, request: r, services: services, actor: actor, header: make(http.Header)}
		next.ServeHTTP(rw, r.WithContext(ctx))
		if err := rw.publish(); err != nil {
			rw.status = http.StatusServiceUnavailable
			rw.finish()
			WriteError(w, NewError(CodeAdminUnavailable, "generation publication unavailable"))
			return
		}
		rw.flush()
		rw.finish()
	})
}

type actorContextKey struct{}

type auditResponseWriter struct {
	http.ResponseWriter
	request   *http.Request
	services  Services
	actor     AdminActor
	status    int
	wrote     bool
	header    http.Header
	body      []byte
	streaming bool
}

// Unwrap exposes the underlying ResponseWriter so http.ResponseController can
// reach per-connection controls (write deadlines) through this wrapper.
func (w *auditResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// Flush starts (or continues) a streaming response. The first flush commits
// the buffered headers straight to the client; afterwards writes bypass the
// audit body buffer so long-lived event streams never accumulate memory.
func (w *auditResponseWriter) Flush() {
	flusher, _ := w.ResponseWriter.(http.Flusher)
	if flusher == nil {
		return
	}
	if !w.streaming {
		if !w.wrote {
			w.WriteHeader(http.StatusOK)
		}
		w.flush()
		w.streaming = true
	}
	flusher.Flush()
}

func (w *auditResponseWriter) publish() error {
	if w.services.Generation == nil || w.request == nil || !isGenerationMutation(w.request.URL.Path, w.request.Method) || w.status < 200 || w.status >= 300 {
		return nil
	}
	return w.services.Generation.Publish(w.request.Context(), generationScope(w.request.URL.Path))
}

func isMutationMethod(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}
func isGenerationMutation(path, method string) bool {
	if !isMutationMethod(method) {
		return false
	}
	switch {
	case strings.HasPrefix(path, "/console/accounts"),
		strings.HasPrefix(path, "/console/providers/"),
		strings.HasPrefix(path, "/console/keys"),
		strings.HasPrefix(path, "/console/settings"),
		strings.HasPrefix(path, "/console/proxy-settings"),
		strings.HasPrefix(path, "/console/tools/cache"),
		strings.HasPrefix(path, "/console/tools/reindex"),
		strings.HasPrefix(path, "/console/backups/") && strings.HasSuffix(path, "/restore"):
		return true
	default:
		return false
	}
}

func generationScope(path string) string {
	switch {
	case strings.HasPrefix(path, "/console/providers/"), strings.HasPrefix(path, "/console/accounts"):
		return "accounts"
	case strings.HasPrefix(path, "/console/keys"):
		return "credentials"
	case strings.HasPrefix(path, "/console/proxies"), strings.HasPrefix(path, "/console/settings"), strings.HasPrefix(path, "/console/proxy-settings"):
		return "configuration"
	case strings.HasPrefix(path, "/console/backups"):
		return "backup"
	case strings.HasPrefix(path, "/console/tools/cache"):
		return "cache"
	default:
		return "lifecycle"
	}
}

func (w *auditResponseWriter) Header() http.Header {
	return w.header
}

func (w *auditResponseWriter) WriteHeader(status int) {
	if !w.wrote {
		w.status = status
		w.wrote = true
	}
}

func (w *auditResponseWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if w.streaming {
		// Streaming responses pass through unbuffered; the audit trail for
		// streams is scope + status, never the event payload.
		return w.ResponseWriter.Write(p)
	}
	w.body = append(w.body, p...)
	return len(p), nil
}

func (w *auditResponseWriter) flush() {
	if w.streaming {
		return
	}
	for key, values := range w.header {
		w.ResponseWriter.Header()[key] = append([]string(nil), values...)
	}
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.ResponseWriter.WriteHeader(w.status)
	if len(w.body) > 0 {
		_, _ = w.ResponseWriter.Write(w.body)
	}
}

func (w *auditResponseWriter) finish() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.services.Audit == nil || w.request == nil || w.request.Method == http.MethodGet || w.request.Method == http.MethodHead {
		return
	}
	event := AuditEvent{
		Actor:  boundedAuditField(w.actor.ID),
		Action: boundedAuditField(strings.ToLower(w.request.Method) + " " + w.request.URL.Path),
		Scope:  boundedAuditField(string(adminScopeForPath(w.request.URL.Path))),
		Path:   boundedAuditField(w.request.URL.Path),
		Method: boundedAuditField(w.request.Method),
		Result: auditResult(w.status),
		Status: w.status,
	}
	_ = w.services.Audit.Emit(w.request.Context(), event)
}

func auditResult(status int) string {
	if status >= 200 && status < 400 {
		return "success"
	}
	return "failure"
}
func statusForAdminError(err error) int {
	var adminErr *Error
	if !errors.As(err, &adminErr) || adminErr == nil {
		return http.StatusInternalServerError
	}
	switch adminErr.Code {
	case CodeAdminAuthentication:
		return http.StatusUnauthorized
	case CodeAdminForbidden:
		return http.StatusForbidden
	case CodeAdminInvalidRequest:
		return http.StatusBadRequest
	case CodeAdminUnavailable:
		return http.StatusServiceUnavailable
	default:
		return statusFor(adminErr.Code)
	}
}
func boundedAuditField(value string) string {
	if len(value) <= 256 {
		return value
	}
	return value[:256]
}
