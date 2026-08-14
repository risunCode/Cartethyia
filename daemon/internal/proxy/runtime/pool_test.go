package proxy

import (
	"context"
	"errors"
	"testing"
	"time"
)

type poolFixture struct{ accounts []Account }

func (f poolFixture) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), f.accounts...), nil
}
func TestPoolSelectionDeterministicAndHealthAware(t *testing.T) {
	now := time.Now()
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{{ID: "b", Enabled: true}, {ID: "a", Enabled: true}}}, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	first, err := p.GetNext(context.Background(), "openai")
	if err != nil || first.ID != "a" {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	p.MarkTransient(first.ID)
	second, err := p.GetNext(context.Background(), "openai")
	if err != nil || second.ID != "b" {
		t.Fatalf("second=%#v err=%v", second, err)
	}
	p.MarkAuthentication(second.ID)
	if _, err := p.GetNext(context.Background(), "openai"); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("auth cooled account selected: %v", err)
	}
}
func TestPoolLeastLoadTieBreaksByID(t *testing.T) {
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{{ID: "z", Enabled: true}, {ID: "a", Enabled: true}}}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	a, err := p.GetByLeastLoad(context.Background(), "openai")
	if err != nil || a.ID != "a" {
		t.Fatalf("account=%#v err=%v", a, err)
	}
	if err := p.Start(a.ID); err != nil {
		t.Fatal(err)
	}
	b, err := p.GetByLeastLoad(context.Background(), "openai")
	if err != nil || b.ID != "z" {
		t.Fatalf("loaded account=%#v err=%v", b, err)
	}
	p.End(a.ID)
}
func TestPoolSelectionExcludesAttemptedAccountsWithoutAdvancingOnFailure(t *testing.T) {
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{
		{ID: "b", Enabled: true},
		{ID: "a", Enabled: true},
	}}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	excluded := map[string]struct{}{"a": {}}
	account, err := p.GetNextExcluding(context.Background(), "openai", excluded)
	if err != nil || account.ID != "b" {
		t.Fatalf("excluded selection account=%#v err=%v", account, err)
	}

	if _, err := p.GetNextExcluding(context.Background(), "openai", map[string]struct{}{"a": {}, "b": {}}); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("all-excluded selection err=%v, want ErrNoAccount", err)
	}

	// The failed all-excluded lookup must not move the cursor. The successful
	// lookup above selected b, so the next ordinary lookup starts at a.
	next, err := p.GetNext(context.Background(), "openai")
	if err != nil || next.ID != "a" {
		t.Fatalf("post-failure cursor account=%#v err=%v", next, err)
	}
}
