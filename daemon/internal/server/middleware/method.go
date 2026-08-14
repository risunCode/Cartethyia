package middleware

import "net/http"

// Methods returns a middleware that rejects requests whose HTTP method is
// not in the allowed set. The response advertises the allowed methods via
// the Allow header and returns 405 with a small JSON body.
func Methods(allowed ...string) func(http.Handler) http.Handler {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, m := range allowed {
		allowedSet[m] = struct{}{}
	}

	allow := joinMethods(allowed)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := allowedSet[r.Method]; !ok {
				w.Header().Set("Allow", allow)
				writeError(w, http.StatusMethodNotAllowed, "method not allowed")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func joinMethods(methods []string) string {
	if len(methods) == 0 {
		return ""
	}
	total := 0
	for _, m := range methods {
		total += len(m) + 2 // ", "
	}
	buf := make([]byte, 0, total)
	for i, m := range methods {
		if i > 0 {
			buf = append(buf, ", "...)
		}
		buf = append(buf, m...)
	}
	return string(buf)
}
