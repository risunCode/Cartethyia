package contracts

import (
	"errors"
	"net/http"
	"testing"
)

func TestAllSurfacesReturnsStableSupportedOrder(t *testing.T) {
	want := []Surface{
		SurfaceOpenAIChat,
		SurfaceOpenAIResponses,
		SurfaceAnthropic,
		SurfaceGemini,
		SurfaceImages,
		SurfaceWebSearch,
	}
	got := AllSurfaces()
	if len(got) != len(want) {
		t.Fatalf("AllSurfaces length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("AllSurfaces()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	got[0] = "mutated"
	if AllSurfaces()[0] != SurfaceOpenAIChat {
		t.Fatal("AllSurfaces returned shared mutable storage")
	}
}

func TestSurfaceAndRateEnumsValidateKnownValues(t *testing.T) {
	tests := []struct {
		name  string
		valid func() bool
		want  bool
	}{
		{"surface known", func() bool { return SurfaceOpenAIChat.IsValid() }, true},
		{"surface unknown", func() bool { return Surface("unknown").IsValid() }, false},
		{"source known", func() bool { return RateSourceProviderQuota.IsValid() }, true},
		{"source unknown", func() bool { return RateSource("unknown").IsValid() }, false},
		{"scope known", func() bool { return RateScopeOrganization.IsValid() }, true},
		{"scope unknown", func() bool { return RateScope("unknown").IsValid() }, false},
		{"phase known", func() bool { return RatePhasePartialWork.IsValid() }, true},
		{"phase unknown", func() bool { return RatePhase("unknown").IsValid() }, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.valid(); got != tc.want {
				t.Fatalf("valid = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRouteErrorMethodsExposeSafeMetadata(t *testing.T) {
	cause := errors.New("secret upstream body")
	e := &RouteError{
		Code: "provider_rate_limit", Message: "try later", Err: cause,
		Retryable: true, RetryAfterMS: 1500, AlternateAccountEligible: true,
		RateSource: RateSourceProviderRate, Scope: RateScopeAccount,
		Phase: RatePhaseProvider,
	}
	if got := e.CodeString(); got != "provider_rate_limit" {
		t.Fatalf("CodeString = %q", got)
	}
	if got := e.Error(); got != "try later" {
		t.Fatalf("Error = %q", got)
	}
	if got := e.Unwrap(); got != cause {
		t.Fatalf("Unwrap = %v, want cause", got)
	}
	code, retryable, retryAfter, alternate, source, scope, phase := e.LifecycleEvidence()
	if code != e.Code || !retryable || retryAfter != 1500 || !alternate || source != string(RateSourceProviderRate) || scope != string(RateScopeAccount) || phase != string(RatePhaseProvider) {
		t.Fatalf("LifecycleEvidence = %q, %v, %d, %v, %q, %q, %q", code, retryable, retryAfter, alternate, source, scope, phase)
	}
	if got := e.Error(); got == cause.Error() {
		t.Fatal("Error exposed wrapped cause")
	}
}

func TestRouteErrorLifecycleEvidencePrefersCanonicalRateFields(t *testing.T) {
	e := &RouteError{
		Code: "quota", RateSource: RateSourceAccountQuota, RateScope: RateScopeModel,
		RatePhase: RatePhasePartialWork, Scope: RateScopeAccount, Phase: RatePhaseProvider,
	}
	_, _, _, _, source, scope, phase := e.LifecycleEvidence()
	if source != string(RateSourceAccountQuota) || scope != string(RateScopeModel) || phase != string(RatePhasePartialWork) {
		t.Fatalf("canonical metadata not preferred: %q, %q, %q", source, scope, phase)
	}

	fallback := &RouteError{Scope: RateScopeRoute, Phase: RatePhasePreDispatch}
	_, _, _, _, source, scope, phase = fallback.LifecycleEvidence()
	if source != "" || scope != string(RateScopeRoute) || phase != string(RatePhasePreDispatch) {
		t.Fatalf("fallback metadata = %q, %q, %q", source, scope, phase)
	}
}

func TestNilRouteErrorMethodsAreSafe(t *testing.T) {
	var e *RouteError
	if e.CodeString() != "" || e.Error() != "<nil>" || e.Unwrap() != nil {
		t.Fatal("nil RouteError methods returned unexpected values")
	}
	code, retryable, retryAfter, alternate, source, scope, phase := e.LifecycleEvidence()
	if code != "" || retryable || retryAfter != 0 || alternate || source != "" || scope != "" || phase != "" {
		t.Fatalf("nil LifecycleEvidence = %q, %v, %d, %v, %q, %q, %q", code, retryable, retryAfter, alternate, source, scope, phase)
	}
}

func TestRequestAndResponseEnvelopesPreserveTransportFields(t *testing.T) {
	headers := http.Header{"X-Test": {"value"}}
	req := Request{Protocol: ProtocolOpenAIChat, Operation: 2, Model: "model", Headers: headers, Body: []byte(`{}`), Stream: true, ContinuationScope: "scope"}
	if req.Protocol != SurfaceOpenAIChat || req.Operation != 2 || req.Model != "model" || !req.Stream || req.ContinuationScope != "scope" || req.Headers.Get("X-Test") != "value" {
		t.Fatalf("request fields not preserved: %+v", req)
	}
	resp := Response{StatusCode: 201, Headers: headers, Body: []byte("ok")}
	if resp.StatusCode != 201 || resp.Headers.Get("X-Test") != "value" || string(resp.Body) != "ok" {
		t.Fatalf("response fields not preserved: %+v", resp)
	}
}
