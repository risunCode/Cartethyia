package middleware

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
)

// HeaderAuthorization is the canonical request header carrying credentials.
const HeaderAuthorization = "Authorization"

// SchemeBearer identifies bearer token credentials.
const SchemeBearer = "Bearer"

// SchemeAPIKey identifies API key credentials transmitted via header.
const SchemeAPIKey = "ApiKey"

// Identity represents a resolved request principal. It is intentionally
// minimal: middleware does not decide what a caller is allowed to do, only
// who they are.
type Identity struct {
	Subject string
	Kind    string
	Raw     string
}

// APIKeyResolver looks up the canonical secret for an opaque API key. The
// middleware compares secrets using a constant-time compare; resolvers
// therefore only need to return the stored material, never the incoming key.
type APIKeyResolver interface {
	LookupAPIKey(ctx context.Context, key string) (Identity, error)
}

// Authenticate runs header extraction, scheme parsing, and credential
// validation. The request context receives the resolved Identity via
// WithIdentity so downstream handlers can read it.
func Authenticate(resolver APIKeyResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			creds, ok := ExtractCredentials(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "missing or invalid credentials")
				return
			}

			switch creds.Scheme {
			case SchemeBearer, SchemeAPIKey:
				if resolver == nil {
					writeError(w, http.StatusInternalServerError, "credential resolver not configured")
					return
				}
				identity, err := resolver.LookupAPIKey(r.Context(), creds.Token)
				if err != nil {
					writeError(w, http.StatusUnauthorized, "invalid credentials")
					return
				}
				if !matchesSecret(creds.Token, identity.Raw) {
					writeError(w, http.StatusUnauthorized, "invalid credentials")
					return
				}
				next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), identity)))
			default:
				writeError(w, http.StatusUnauthorized, "unsupported authentication scheme")
			}
		})
	}
}

// Credentials is the result of parsing an Authorization header. Schemes
// other than bearer/api-key are surfaced so callers can decide how to
// react.
type Credentials struct {
	Scheme string
	Token  string
}

// ExtractCredentials parses the Authorization header and returns the scheme
// alongside the credential material. The boolean is false when the header
// is missing or malformed.
func ExtractCredentials(r *http.Request) (Credentials, bool) {
	if r == nil {
		return Credentials{}, false
	}
	header := r.Header.Get(HeaderAuthorization)
	if header == "" {
		return Credentials{}, false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 {
		return Credentials{}, false
	}
	scheme := strings.TrimSpace(parts[0])
	token := strings.TrimSpace(parts[1])
	if scheme == "" || token == "" {
		return Credentials{}, false
	}
	return Credentials{Scheme: scheme, Token: token}, true
}

// WithIdentity returns a context carrying the resolved Identity.
func WithIdentity(parent context.Context, id Identity) context.Context {
	return context.WithValue(parent, contextKeyIdentity, id)
}

// IdentityFrom returns the Identity stored on the context. The second
// return value reports whether one was present.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	if ctx == nil {
		return Identity{}, false
	}
	v, ok := ctx.Value(contextKeyIdentity).(Identity)
	return v, ok
}

// matchesSecret compares the presented token to the stored secret using a
// constant-time check. An empty stored secret is treated as a miss.
func matchesSecret(presented, stored string) bool {
	if presented == "" || stored == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(stored)) == 1
}
