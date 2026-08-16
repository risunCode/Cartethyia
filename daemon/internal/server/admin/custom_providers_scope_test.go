package admin

import "testing"

func TestCustomProvidersRoutesRequireConfigScope(t *testing.T) {
	paths := []string{
		"/v2/admin/custom-providers",
		"/v2/admin/custom-providers/prov_123",
	}
	for _, path := range paths {
		if got := adminScopeForPath(path); got != ScopeConfig {
			t.Fatalf("adminScopeForPath(%q) = %q want %q", path, got, ScopeConfig)
		}
	}
	// Adjacent configuration routes keep their existing scope assignment.
	if got := adminScopeForPath("/v2/admin/proxies"); got != ScopeConfig {
		t.Fatalf("proxies scope = %q", got)
	}
	if got := adminScopeForPath("/v2/admin/telemetry/overview"); got != ScopeUsage {
		t.Fatalf("telemetry scope = %q", got)
	}
}
