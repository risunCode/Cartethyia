package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	proxycontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func FuzzReadBoundedJSON(f *testing.F) {
	const secretSentinel = "credential-SENTINEL-bounded-json"
	seeds := []struct {
		body  []byte
		limit uint16
	}{
		{body: []byte(`{"model":"gpt","messages":[{"role":"user","content":"hello"}]}`), limit: 1024},
		{body: []byte(`{"model":"gpt","input":"hello","stream":true}`), limit: 1024},
		{body: []byte(`{"model":"claude","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`), limit: 1024},
		{body: []byte(`{"value":"` + secretSentinel + `"}`), limit: 8},
		{body: []byte(`{"one":1}{"two":2}`), limit: 1024},
		{body: []byte{'{', '"', 'x', '"', ':', 0xff, '}'}, limit: 1024},
	}
	for _, seed := range seeds {
		f.Add(seed.body, seed.limit)
	}

	f.Fuzz(func(t *testing.T, body []byte, encodedLimit uint16) {
		if len(body) > 16<<10 {
			body = body[:16<<10]
		}
		limit := int64(encodedLimit%8192) + 1
		decode := func() ([]byte, error) {
			req := httptest.NewRequest(http.MethodPost, "/v1/fuzz", bytes.NewReader(body))
			return ReadBoundedJSON(req, limit)
		}

		first, firstErr := decode()
		second, secondErr := decode()
		if (firstErr == nil) != (secondErr == nil) {
			t.Fatalf("decode stability mismatch: first=%v second=%v", firstErr, secondErr)
		}
		if firstErr != nil {
			var firstRouteErr, secondRouteErr *proxycontracts.RouteError
			if !errors.As(firstErr, &firstRouteErr) || !errors.As(secondErr, &secondRouteErr) {
				t.Fatalf("bounded JSON error types = %T/%T, want RouteError", firstErr, secondErr)
			}
			if firstRouteErr.Kind != secondRouteErr.Kind || firstRouteErr.Code != secondRouteErr.Code || firstRouteErr.StatusCode != secondRouteErr.StatusCode {
				t.Fatalf("unstable bounded JSON classification: first=%+v second=%+v", firstRouteErr, secondRouteErr)
			}
			if strings.Contains(firstErr.Error(), secretSentinel) || strings.Contains(firstRouteErr.Message, secretSentinel) {
				t.Fatalf("bounded JSON error leaked secret sentinel: %q", firstErr)
			}
			return
		}
		if !bytes.Equal(first, second) {
			t.Fatalf("canonical JSON is nondeterministic: %q != %q", first, second)
		}
		if !json.Valid(first) {
			t.Fatalf("successful bounded decode returned invalid JSON: %q", first)
		}
		if len(first) > int(limit)*6+64 {
			t.Fatalf("canonical JSON length=%d exceeds bounded expansion for limit=%d", len(first), limit)
		}
	})
}
