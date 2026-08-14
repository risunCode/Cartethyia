package proxy

import (
	"context"
	"errors"
	"testing"
	"time"
)

func selectableCandidate(id string) AccountSelectionCandidate {
	return AccountSelectionCandidate{
		ID: id, Provider: "openai", Model: "gpt-5",
		Enabled: true, Authorized: true, Compatible: true, QuotaAvailable: true,
		Health: StateHealthy,
	}
}

func TestSelectAccountCandidateDeterministicAcrossInputOrder(t *testing.T) {
	in := AccountSelectionInput{Provider: "openai", Model: "gpt-5", Affinity: AffinityKey{Namespace: "api_key", Value: "k"}, Now: time.Unix(10, 0)}
	a := selectableCandidate("a")
	b := selectableCandidate("b")
	first, _, err := SelectAccountCandidate(context.Background(), in, []AccountSelectionCandidate{b, a})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := SelectAccountCandidate(context.Background(), in, []AccountSelectionCandidate{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("selection changed with input order: %q vs %q", first.ID, second.ID)
	}
}

func TestSelectAccountCandidateFiltersHealthQuotaLocksAndOperatorOverrides(t *testing.T) {
	now := time.Unix(100, 0)
	locked := selectableCandidate("locked")
	locked.ModelLocks = map[string]time.Time{"gpt-5": now.Add(time.Minute)}
	cooling := selectableCandidate("cooling")
	cooling.CooldownUntil = now.Add(time.Minute)
	quarantined := selectableCandidate("quarantined")
	quarantined.Quarantined = true
	healthy := selectableCandidate("healthy")
	chosen, decision, err := SelectAccountCandidate(context.Background(), AccountSelectionInput{Provider: "openai", Model: "gpt-5", Now: now}, []AccountSelectionCandidate{locked, cooling, quarantined, healthy})
	if err != nil {
		t.Fatal(err)
	}
	if chosen.ID != "healthy" || decision.CandidateID != "healthy" {
		t.Fatalf("chosen=%q decision=%q", chosen.ID, decision.CandidateID)
	}
	if len(decision.ExcludedCandidateIDs) != 3 {
		t.Fatalf("excluded=%v", decision.ExcludedCandidateIDs)
	}
}

func TestRankAccountCandidatesBoundsFallbackAndErrors(t *testing.T) {
	candidates := make([]AccountSelectionCandidate, 3)
	for i := range candidates {
		candidates[i] = selectableCandidate(string(rune('a' + i)))
	}
	ranked, _, err := RankAccountCandidates(context.Background(), AccountSelectionInput{Provider: "openai", MaxFallback: 2}, candidates)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranked) != 2 {
		t.Fatalf("ranked=%d, want 2", len(ranked))
	}
	_, _, err = RankAccountCandidates(context.Background(), AccountSelectionInput{Provider: "openai"}, []AccountSelectionCandidate{selectableCandidate("dup"), selectableCandidate("dup")})
	if !errors.Is(err, ErrInvalidCandidate) {
		t.Fatalf("duplicate error=%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = RankAccountCandidates(ctx, AccountSelectionInput{}, candidates)
	if !errors.Is(err, ErrSelectionCanceled) {
		t.Fatalf("canceled error=%v", err)
	}
}

func TestNetworkSelectionRetainsIdempotentProxyRelease(t *testing.T) {
	selector := NewDefaultNetworkSelector()
	selector.SetCapacity("proxy-1", 1)
	selection, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode:    NetworkModeAuto,
		Proxies: []ProxyEndpoint{{ID: "proxy-1", Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !selection.UseProxy || selection.Release == nil {
		t.Fatalf("selection=%+v, want retained proxy release token", selection)
	}
	busy, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode:    NetworkModeAuto,
		Proxies: []ProxyEndpoint{{ID: "proxy-1", Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if busy.UseProxy {
		t.Fatalf("second selection unexpectedly acquired slot: %+v", busy)
	}
	selection.Release()
	selection.Release()
	available, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode:    NetworkModeAuto,
		Proxies: []ProxyEndpoint{{ID: "proxy-1", Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !available.UseProxy {
		t.Fatalf("slot was not released after successful selection: %+v", available)
	}
	available.Release()
}

func TestNetworkSelectionDirectDoesNotReserveProxySlot(t *testing.T) {
	selector := NewDefaultNetworkSelector()
	selector.SetCapacity("proxy-1", 1)
	direct, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode:    NetworkModeDirect,
		Proxies: []ProxyEndpoint{{ID: "proxy-1", Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if direct.UseProxy || direct.Release != nil {
		t.Fatalf("direct selection retained a proxy reservation: %+v", direct)
	}
	proxied, err := selector.Select(context.Background(), SelectNetworkInput{
		Mode:    NetworkModeAuto,
		Proxies: []ProxyEndpoint{{ID: "proxy-1", Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !proxied.UseProxy {
		t.Fatalf("direct selection consumed proxy slot: %+v", proxied)
	}
	proxied.Release()
}

func TestSafeHostnameRejectsPrivateAndLinkLocalLiterals(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "127.0.0.1:80", "10.0.0.8", "169.254.1.2", "::1", "[fe80::1]", "[::1]:443", "100.64.0.1"} {
		if SafeHostname(host) {
			t.Errorf("SafeHostname(%q)=true, want rejection", host)
		}
	}
	if !SafeHostname("api.example.com") {
		t.Fatal("public hostname was rejected")
	}
}
