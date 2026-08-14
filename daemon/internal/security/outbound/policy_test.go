package outbound

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type staticResolver map[string][]net.IPAddr

func (r staticResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	return r[host], nil
}
func TestPolicyRejectsPrivateAndAllowsPublic(t *testing.T) {
	p := Policy{Resolver: staticResolver{"private.test": {{IP: net.ParseIP("10.0.0.1")}}, "public.test": {{IP: net.ParseIP("93.184.216.34")}}}}
	if _, err := p.Validate(context.Background(), "https://private.test/v1"); !errors.Is(err, ErrPrivateAddress) {
		t.Fatalf("private err=%v", err)
	}
	if _, err := p.Validate(context.Background(), "https://public.test/v1"); err != nil {
		t.Fatalf("public err=%v", err)
	}
}
func TestPolicyRejectsUserinfoAndUnsupportedScheme(t *testing.T) {
	p := Policy{AllowPrivate: true, AllowLoopback: true, Resolver: staticResolver{"example.test": {{IP: net.ParseIP("93.184.216.34")}}}}
	if _, err := p.Validate(context.Background(), "file:///tmp/x"); !errors.Is(err, ErrUnsupportedScheme) {
		t.Fatalf("scheme err=%v", err)
	}
	if _, err := p.Validate(context.Background(), "https://user:pass@example.test"); !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("userinfo err=%v", err)
	}
}
func TestPolicyClientRejectsRedirectsWhenDisabled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:1/private", http.StatusFound)
	}))
	defer server.Close()
	client := (Policy{AllowLoopback: true, AllowPrivate: true, MaxRedirects: 0}).Client(nil)
	_, err := client.Get(server.URL)
	if !errors.Is(err, ErrRedirectDenied) {
		t.Fatalf("redirect error = %v", err)
	}
}
func TestPolicyRejectsUnsafeAddressClasses(t *testing.T) {
	tests := []struct {
		name     string
		ip       string
		wantErr  error
		wantCode Code
	}{
		{name: "loopback", ip: "127.0.0.1", wantErr: ErrPrivateAddress, wantCode: CodePrivateAddress},
		{name: "private", ip: "10.0.0.1", wantErr: ErrPrivateAddress, wantCode: CodePrivateAddress},
		{name: "link-local", ip: "169.254.1.1", wantErr: ErrPrivateAddress, wantCode: CodePrivateAddress},
		{name: "multicast", ip: "224.0.0.1", wantErr: ErrPrivateAddress, wantCode: CodePrivateAddress},
		{name: "reserved", ip: "192.0.2.1", wantErr: ErrPrivateAddress, wantCode: CodePrivateAddress},
		{name: "short-ip", ip: "127.1", wantCode: CodeInvalidURL},
		{name: "decimal-ip", ip: "2130706433", wantCode: CodeInvalidURL},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			p := Policy{}
			_, err := p.Validate(context.Background(), "https://"+test.ip+"/v1")
			if err == nil {
				t.Fatal("unsafe address was accepted")
			}
			if test.wantErr != nil && !errors.Is(err, test.wantErr) {
				t.Fatalf("error=%v, want %v", err, test.wantErr)
			}
			if got := ErrorCode(err); got != test.wantCode {
				t.Fatalf("error code=%q, want %q", got, test.wantCode)
			}
		})
	}
}

func TestPolicyRejectsUnsafeInitialConnectionBeforeRoundTrip(t *testing.T) {
	called := false
	base := roundTripperFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("must not connect")
	})
	p := Policy{Resolver: staticResolver{"private.test": {{IP: net.ParseIP("10.0.0.1")}}}}
	_, err := p.Client(base).Get("https://private.test/v1")
	if !errors.Is(err, ErrPrivateAddress) {
		t.Fatalf("error=%v, want private-address rejection", err)
	}
	if called {
		t.Fatal("unsafe destination reached the transport")
	}
}

func TestPolicyRevalidatesRedirectTarget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://private.test/private", http.StatusFound)
	}))
	defer server.Close()
	p := Policy{
		AllowLoopback: true,
		MaxRedirects:  1,
		Resolver: staticResolver{
			"private.test": {{IP: net.ParseIP("10.0.0.1")}},
		},
	}
	_, err := p.Client(nil).Get(server.URL)
	if !errors.Is(err, ErrRedirectDenied) {
		t.Fatalf("error=%v, want redirect denial", err)
	}
	if got := ErrorCode(err); got != CodeRedirectDenied {
		t.Fatalf("error code=%q, want %q", got, CodeRedirectDenied)
	}
}

func TestPolicyAllowsExplicitPublicRoute(t *testing.T) {
	p := Policy{
		AllowedHosts: map[string]struct{}{"allowed.example": {}},
		Resolver:     staticResolver{"allowed.example": {{IP: net.ParseIP("93.184.216.34")}}},
	}
	u, err := p.Validate(context.Background(), "https://ALLOWED.EXAMPLE./v1")
	if err != nil {
		t.Fatalf("allowed route rejected: %v", err)
	}
	if got := u.Hostname(); got != "ALLOWED.EXAMPLE." {
		t.Fatalf("URL host changed unexpectedly: %q", got)
	}
	if _, err := p.Validate(context.Background(), "https://other.example/v1"); ErrorCode(err) != CodeInvalidURL {
		t.Fatalf("unallowlisted route error=%v, code=%q", err, ErrorCode(err))
	}
}

type testProxyHealth struct {
	healthy bool
	enabled bool
}

func (h testProxyHealth) IsHealthy(string, time.Time) bool { return h.healthy }
func (h testProxyHealth) IsEnabled(string) bool            { return h.enabled }

func TestPolicyGatesUnhealthyProxyBeforeConnection(t *testing.T) {
	p := Policy{
		ProxyID:     "proxy-1",
		ProxyHealth: testProxyHealth{healthy: false, enabled: true},
		Resolver:    staticResolver{"allowed.example": {{IP: net.ParseIP("93.184.216.34")}}},
	}
	_, err := p.Validate(context.Background(), "https://allowed.example/v1")
	if !errors.Is(err, ErrProxyUnhealthy) {
		t.Fatalf("error=%v, want unhealthy proxy", err)
	}
	if got := ErrorCode(err); got != CodeProxyUnhealthy {
		t.Fatalf("error code=%q, want %q", got, CodeProxyUnhealthy)
	}
}

func TestPolicyRejectsEmptyDNSAnswer(t *testing.T) {
	p := Policy{Resolver: staticResolver{"empty.example": nil}}
	_, err := p.Validate(context.Background(), "https://empty.example/v1")
	if !errors.Is(err, ErrResolutionFailed) {
		t.Fatalf("error=%v, want resolution failure", err)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

type rotatingResolver struct {
	results [][]net.IPAddr
	calls   int
}

func (r *rotatingResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	result := r.results[r.calls]
	r.calls++
	return result, nil
}

func TestPolicyRechecksDNSAtDialForRebinding(t *testing.T) {
	resolver := &rotatingResolver{results: [][]net.IPAddr{
		{{IP: net.ParseIP("127.0.0.1")}},
		{{IP: net.ParseIP("10.0.0.1")}},
	}}
	transport := &http.Transport{Proxy: nil}
	client := (Policy{
		AllowLoopback: true,
		Resolver:      resolver,
	}).Client(transport)
	_, err := client.Get("http://rebind.test:1/v1")
	if !errors.Is(err, ErrPrivateAddress) {
		t.Fatalf("error=%v, want dial-time private-address rejection", err)
	}
	if resolver.calls < 2 {
		t.Fatalf("resolver calls=%d, want validation and dial-time checks", resolver.calls)
	}
}

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
