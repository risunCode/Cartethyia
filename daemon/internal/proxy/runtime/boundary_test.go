package proxy

import "testing"

func TestConstructorsRejectMissingDependencies(t *testing.T) {
	if _, err := NewAccountPool(PoolConfig{}); err == nil {
		t.Fatal("nil account store accepted")
	}
	if _, err := NewRouter(RouterConfig{}); err == nil {
		t.Fatal("nil account pool accepted")
	}
}
