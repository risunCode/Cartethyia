package middleware

import "net/http"

// Chain composes middleware in the order given, so the first element runs
// outermost. It panics if any element is nil so wiring mistakes surface
// during startup rather than at request time.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	if h == nil {
		panic("middleware: base handler must not be nil")
	}
	for i := len(mws) - 1; i >= 0; i-- {
		if mws[i] == nil {
			panic("middleware: middleware function must not be nil")
		}
		h = mws[i](h)
	}
	return h
}
