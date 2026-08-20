package middleware

import "net/http"

// BanList is the contract for manual IP bans. It is intentionally separate
// from automated security-offense tracking (fail2ban-style) so deployments
// can opt in or out without code changes.
type BanList interface {
	// IsBanned reports whether the given client identifier is currently
	// subject to a manual ban. A non-nil error indicates the backing
	// store is unavailable; the middleware treats that as fail-open and
	// logs the condition through the standard error path.
	IsBanned(clientID string) (bool, error)
}

// ManualBan rejects requests whose client identifier is present on the
// configured ban list. The check is fail-open: if the ban store errors, the
// request proceeds and a sentinel error response is returned only when the
// caller wires one explicitly via the supplied onError hook.
func ManualBan(bans BanList, onError func(error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if bans == nil {
				next.ServeHTTP(w, r)
				return
			}
			client := ClientKey(r)
			if client == "" {
				next.ServeHTTP(w, r)
				return
			}
			banned, err := bans.IsBanned(client)
			if err != nil {
				if onError != nil {
					onError(err)
				}
				next.ServeHTTP(w, r)
				return
			}
			if banned {
				writeError(w, http.StatusForbidden, "client is banned")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
