package telemetry

import "testing"

func TestLifecycleKeysAndRateTaxonomyAreBounded(t *testing.T) {
	keys := []LifecycleKey{
		EventIncomingRequest, EventRouteSelected, EventProviderAttempt,
		EventRequestSucceeded, EventRequestFailed, EventRequestRetried,
		EventRequestFallback, EventTokenRefreshStarted, EventTokenRefreshSucceeded,
		EventTokenRefreshTransient, EventTokenRefreshReauth, EventTokenRefreshFailed,
		EventRequestCancelled, EventRequestCompleted,
	}
	for _, key := range keys {
		if !key.IsValid() {
			t.Errorf("key %q is not valid", key)
		}
	}
	if LifecycleKey("prompt:" + "secret").IsValid() {
		t.Fatal("arbitrary lifecycle keys must not be accepted")
	}
	for _, source := range []RateSource{
		RateSourceLocalRateLimit, RateSourceLocalConcurrency,
		RateSourceProviderRateLimit, RateSourceProviderQuota,
		RateSourceAllowedTokens, RateSourceAccountQuota, RateSourceCoordination,
	} {
		if !source.IsValid() {
			t.Errorf("source %q is not valid", source)
		}
	}
	if RateSource("rate_limited").IsValid() {
		t.Fatal("generic rate source must not be accepted")
	}
}

func TestIdentityResolutionUsesSafePrecedence(t *testing.T) {
	if got, source := ResolveAccountDisplay("  operator@example.test ", "configured", "acct-1"); got != "operator@example.test" || source != "email" {
		t.Fatalf("account email resolution got %q/%q", got, source)
	}
	if got, source := ResolveAccountDisplay("", "Configured", "acct-1"); got != "Configured" || source != "configured" {
		t.Fatalf("account configured resolution got %q/%q", got, source)
	}
	if got, source := ResolveProxyDisplay("", "proxy-1"); got != "proxy-1" || source != "proxy_id" {
		t.Fatalf("proxy resolution got %q/%q", got, source)
	}
}
