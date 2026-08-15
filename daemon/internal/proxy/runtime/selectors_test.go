package proxy

import (
	"context"
	"testing"
)

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
