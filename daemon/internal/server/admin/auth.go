package admin

import (
	"net/http"
	"strings"
)

// RegisterAuth wires /console/auth/* session and OAuth routes.
func RegisterAuth(mux *http.ServeMux, services Services) {
	auth := services.Auth
	var oauth OAuthLifecycleService = services.OAuth
	if oauth == nil {
		oauth = auth
	}
	if auth == nil && oauth == nil {
		return
	}

	if auth != nil {
		mux.HandleFunc("/console/auth/login", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
				var input LoginInput
				if err := decodeJSON(r, &input); err != nil {
					WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
					return
				}
				result, err := auth.Login(r.Context(), input, buildAuthRequest(r))
			if err != nil {
				WriteError(w, err)
				return
			}
			if result.SetCookie != "" {
				w.Header().Add("Set-Cookie", result.SetCookie)
			}
			WriteData(w, http.StatusOK, result.Session)
		}))

		mux.HandleFunc("/console/auth/logout", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
			sessionID := readSessionID(r)
			if err := auth.Logout(r.Context(), sessionID); err != nil {
				WriteError(w, err)
				return
			}
			// Stateless tokens cannot be revoked server-side; expiring the
			// cookie is the logout contract.
			w.Header().Add("Set-Cookie", "cartethyia_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
			WriteOK(w)
		}))

		mux.HandleFunc("/console/auth/session", requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			sessionID := readSessionID(r)
			session, err := auth.Current(r.Context(), sessionID)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, session)
		}))

		mux.HandleFunc("/console/auth/refresh", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
			sessionID := readSessionID(r)
			session, err := auth.Refresh(r.Context(), sessionID)
			if err != nil {
				WriteError(w, err)
				return
			}
			WriteData(w, http.StatusOK, session)
		}))
	}

	mux.HandleFunc("/console/auth/oauth/start", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		providerID := strings.TrimSpace(r.URL.Query().Get("providerId"))
		if providerID == "" || len(providerID) > maxAdminField || strings.IndexFunc(providerID, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			WriteError(w, NewError(CodeInvalidRequest, "providerId query parameter is required and bounded"))
			return
		}
		var input OAuthStartInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		state, err := oauth.OAuthStart(r.Context(), providerID, input)
		if err != nil {
			WriteError(w, err)
			return
		}
		writeOAuthState(w, state)
	}))

	mux.HandleFunc("/console/auth/oauth/sessions/", func(w http.ResponseWriter, r *http.Request) {
		handleOAuthSession(w, r, oauth)
	})

	mux.HandleFunc("/console/auth/oauth/refresh", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input OAuthRefreshInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		state, err := oauth.OAuthRefresh(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		writeOAuthState(w, state)
	}))

	mux.HandleFunc("/console/auth/oauth/reauth", requireMethod(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		var input OAuthRefreshInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		input.Force = true
		var (
			state OAuthState
			err   error
		)
		if reauth, ok := oauth.(OAuthReauthService); ok {
			state, err = reauth.OAuthReauthenticate(r.Context(), input)
		} else {
			state, err = oauth.OAuthRefresh(r.Context(), input)
		}
		if err != nil {
			WriteError(w, err)
			return
		}
		writeOAuthState(w, state)
	}))
}

func handleOAuthSession(w http.ResponseWriter, r *http.Request, svc OAuthLifecycleService) {
	rest := strings.TrimPrefix(r.URL.Path, "/console/auth/oauth/sessions/")
	parts := strings.Split(rest, "/")

	if len(parts) == 0 || parts[0] == "" {
		WriteError(w, NewError(CodeNotFound, "oauth session not found"))
		return
	}

	sessionID := parts[0]
	if sessionID == "" || len(sessionID) > maxAdminField || strings.IndexFunc(sessionID, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		WriteError(w, NewError(CodeInvalidRequest, "oauth session id is required and bounded"))
		return
	}
	tail := parts[1:]

	switch {
	case len(tail) == 0 || len(tail) == 1 && tail[0] == "status":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		var (
			state OAuthState
			err   error
		)
		if status, ok := svc.(OAuthStatusService); ok {
			state, err = status.OAuthStatus(r.Context(), sessionID)
		} else {
			state, err = svc.OAuthComplete(r.Context(), sessionID, OAuthCompleteInput{})
		}
		if err != nil {
			WriteError(w, err)
			return
		}
		writeOAuthState(w, state)
	case len(tail) == 1 && tail[0] == "complete":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		var input OAuthCompleteInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		state, err := svc.OAuthComplete(r.Context(), sessionID, input)
		if err != nil {
			WriteError(w, err)
			return
		}
		writeOAuthState(w, state)
	case len(tail) == 1 && tail[0] == "cancel":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		if err := svc.OAuthCancel(r.Context(), sessionID); err != nil {
			WriteError(w, err)
			return
		}
		WriteOK(w)
	default:
		WriteError(w, NewError(CodeNotFound, "oauth session subroute not found"))
	}
}
func writeOAuthState(w http.ResponseWriter, state OAuthState) {
	state.SessionID = boundedOAuthValue(state.SessionID, maxAdminField)
	state.AccountID = boundedOAuthValue(state.AccountID, maxAdminField)
	state.Status = boundedOAuthValue(state.Status, 64)
	state.Flow = boundedOAuthValue(state.Flow, 32)
	state.URL = boundedOAuthValue(state.URL, 2048)
	state.State = boundedOAuthValue(state.State, maxAdminField)
	state.UserCode = boundedOAuthValue(state.UserCode, maxAdminField)
	state.VerificationURI = boundedOAuthValue(state.VerificationURI, 2048)
	state.ExpiresAt = boundedOAuthValue(state.ExpiresAt, 64)
	if state.IntervalSeconds < 0 || state.IntervalSeconds > 3600 {
		state.IntervalSeconds = 0
	}
	WriteData(w, http.StatusOK, state)
}

func boundedOAuthValue(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		return value[:max]
	}
	return value
}

// readSessionID resolves the session exclusively from the cookie; header and
// query transports were removed with the /console migration.
func readSessionID(r *http.Request) string {
	if cookie, err := r.Cookie("cartethyia_session"); err == nil {
		return cookie.Value
	}
	return ""
}

func buildAuthRequest(r *http.Request) AuthRequest {
	return AuthRequest{
		IP:        clientIP(r),
		UserAgent: r.UserAgent(),
		BaseURL:   baseURLFromRequest(r),
		Secure:    r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	}
}

func clientIP(r *http.Request) string {
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		if comma := strings.IndexByte(h, ','); comma >= 0 {
			return strings.TrimSpace(h[:comma])
		}
		return strings.TrimSpace(h)
	}
	if h := r.Header.Get("X-Real-IP"); h != "" {
		return strings.TrimSpace(h)
	}
	return r.RemoteAddr
}
