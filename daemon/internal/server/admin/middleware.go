package admin

import (
	"net/http"
	"strings"
)

// requireMethod returns a handler that rejects every method except the given
// one. On rejection it emits a 405 with an Allow header listing the only
// accepted method.
func requireMethod(method string, next http.HandlerFunc) http.HandlerFunc {
	method = strings.ToUpper(strings.TrimSpace(method))
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Method, method) {
			writeMethodNotAllowed(w, method)
			return
		}
		next(w, r)
	}
}

// requireMethods is a small dispatcher that picks the right handler for the
// incoming HTTP method. It rejects methods not present in the map and emits
// an Allow header listing the full set of accepted methods.
func requireMethods(handlers map[string]http.HandlerFunc) http.HandlerFunc {
	allowed := make([]string, 0, len(handlers))
	for method := range handlers {
		allowed = append(allowed, method)
	}
	allowHeader := allowedMethodsString(allowed...)

	return func(w http.ResponseWriter, r *http.Request) {
		if handler, ok := matchMethod(handlers, r.Method); ok {
			handler(w, r)
			return
		}
		writeMethodNotAllowedHeader(w, allowHeader)
	}
}

func matchMethod(handlers map[string]http.HandlerFunc, method string) (http.HandlerFunc, bool) {
	if h, ok := handlers[method]; ok {
		return h, true
	}
	for m, h := range handlers {
		if strings.EqualFold(m, method) {
			return h, true
		}
	}
	return nil, false
}

// writeMethodNotAllowed writes a 405 with a single-method Allow header.
func writeMethodNotAllowed(w http.ResponseWriter, methods ...string) {
	writeMethodNotAllowedHeader(w, allowedMethodsString(methods...))
}

func writeMethodNotAllowedHeader(w http.ResponseWriter, allow string) {
	if allow != "" {
		w.Header().Set("Allow", allow)
	}
	WriteError(w, NewError(CodeMethodNotAllowed, "method not allowed"))
}

// dummyResponseWriter is a defensive stand-in used when helpers need to
// forward errors during composition. The admin package never calls it in
// normal flow; it exists so accidental calls compile and degrade gracefully.
type dummyResponseWriter struct{}

func (dummyResponseWriter) Header() http.Header        { return http.Header{} }
func (dummyResponseWriter) Write([]byte) (int, error)  { return 0, nil }
func (dummyResponseWriter) WriteHeader(statusCode int) {}
