package usage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestLedgerReconcilesUnknownTokensWithoutFabrication(t *testing.T) {
	l := New()
	if err := l.Register(Event{RequestID: "r", Attempt: 0, PriceGeneration: 1}); err != nil {
		t.Fatal(err)
	}
	l.PriceGeneration(1, Price{InputPerMillion: 1, OutputPerMillion: 2})
	cost, err := l.Cost("r", 0)
	if err != nil || cost != 0 {
		t.Fatalf("unknown cost=%v err=%v", cost, err)
	}
	in := int64(1000000)
	out := int64(2)
	if err := l.Reconcile("r", 0, Tokens{Input: &in, Output: &out}); err != nil {
		t.Fatal(err)
	}
	cost, err = l.Cost("r", 0)
	if err != nil || cost != 1.000004 {
		t.Fatalf("cost=%v err=%v", cost, err)
	}
}
func TestLedgerRejectsDuplicateAttempts(t *testing.T) {
	l := New()
	e := Event{RequestID: "r", Attempt: 1}
	if err := l.Register(e); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(l.Register(e), ErrDuplicate) {
		t.Fatal("duplicate accepted")
	}
}

type usageRepositoryStub struct {
	appendErr    error
	reconcileErr error
	appends      int
	reconciles   int
}

func (r *usageRepositoryStub) Append(context.Context, Event) error {
	r.appends++
	return r.appendErr
}
func (r *usageRepositoryStub) Reconcile(context.Context, Reconciliation) error {
	r.reconciles++
	return r.reconcileErr
}

func TestLedgerRetriesRemainSeparateAndDeterministic(t *testing.T) {
	l := New()
	if err := l.Register(Event{RequestID: "logical", Attempt: 0, Provider: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := l.Register(Event{RequestID: "logical", Attempt: 1, Provider: "b"}); err != nil {
		t.Fatal(err)
	}
	attempts := l.Attempts("logical")
	if len(attempts) != 2 || attempts[0].Attempt != 0 || attempts[1].Attempt != 1 {
		t.Fatalf("attempts=%#v", attempts)
	}
	if attempts[0].IdempotencyKey != "logical:0" || attempts[1].IdempotencyKey != "logical:1" {
		t.Fatalf("keys=%q,%q", attempts[0].IdempotencyKey, attempts[1].IdempotencyKey)
	}
}

func TestLedgerReconcileIsIdempotentAndPreservesCancellation(t *testing.T) {
	repo := &usageRepositoryStub{}
	l := New(WithRepository(repo))
	if err := l.Register(Event{RequestID: "cancelled", Attempt: 0, PriceGeneration: 1}); err != nil {
		t.Fatal(err)
	}
	if err := l.Cancel("cancelled", 0); err != nil {
		t.Fatal(err)
	}
	value := int64(4)
	if err := l.Reconcile("cancelled", 0, Tokens{Input: &value}); err != nil {
		t.Fatal(err)
	}
	if err := l.Reconcile("cancelled", 0, Tokens{Input: &value}); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if repo.reconciles != 1 {
		t.Fatalf("reconcile writes=%d, want 1", repo.reconciles)
	}
	event, err := l.Get("cancelled", 0)
	if err != nil || !event.Cancelled || !event.Reconciled || event.Tokens.Input == nil || *event.Tokens.Input != value {
		t.Fatalf("event=%#v err=%v", event, err)
	}
}

func TestLedgerMissingUsageIsExplicit(t *testing.T) {
	l := New()
	if err := l.PriceGeneration(1, Price{InputPerMillion: 1}); err != nil {
		t.Fatal(err)
	}
	if err := l.Register(Event{RequestID: "missing", Attempt: 0, PriceGeneration: 1}); err != nil {
		t.Fatal(err)
	}
	breakdown, err := l.CostBreakdown("missing", 0)
	if err != nil || breakdown.Known || len(breakdown.Unknown) != 4 || breakdown.Amount != 0 {
		t.Fatalf("breakdown=%#v err=%v", breakdown, err)
	}
}

func TestLedgerTelemetryOutageIsCodedAndRetryable(t *testing.T) {
	repo := &usageRepositoryStub{appendErr: errors.New("database offline")}
	l := New(WithRepository(repo))
	event := Event{RequestID: "outage", Attempt: 0}
	err := l.Register(event)
	if !errors.Is(err, ErrPersistence) || Code(err) != CodePersistence {
		t.Fatalf("err=%v code=%s", err, Code(err))
	}
	if _, getErr := l.Get("outage", 0); getErr != nil {
		t.Fatalf("local evidence lost during outage: %v", getErr)
	}
	repo.appendErr = nil
	if err := l.Register(event); err != nil {
		t.Fatalf("retry after outage: %v", err)
	}
	if repo.appends != 2 || l.PersistenceFailures() != 1 {
		t.Fatalf("appends=%d failures=%d", repo.appends, l.PersistenceFailures())
	}
}

func TestLedgerPricingGenerationValidationAndRedaction(t *testing.T) {
	l := New()
	if err := l.PriceGeneration(0, Price{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero generation err=%v", err)
	}
	if err := l.PriceGeneration(1, Price{InputPerMillion: 2}); err != nil {
		t.Fatal(err)
	}
	if err := l.PriceGeneration(1, Price{InputPerMillion: 3}); !errors.Is(err, ErrConflict) {
		t.Fatalf("price conflict err=%v", err)
	}
	n := int64(1)
	event := Event{RequestID: "secret-correlation", LogicalRequestID: "logical", IdempotencyKey: "secret-key", Tokens: Tokens{Input: &n}, Transforms: []Transform{{Name: "normalize", Applied: true}}}
	redacted := event.Redacted()
	if redacted.RequestID != "" || redacted.LogicalRequestID != "" || redacted.IdempotencyKey != "" || redacted.Tokens.Input != nil || len(redacted.Transforms) != 1 {
		t.Fatalf("redacted=%#v", redacted)
	}
}

func TestLedgerCancellationContextUsesStableCode(t *testing.T) {
	l := New()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := l.RegisterContext(ctx, Event{RequestID: "cancelled-context", Attempt: 0})
	if !errors.Is(err, ErrCancelled) || Code(err) != CodeCancelled {
		t.Fatalf("err=%v code=%s", err, Code(err))
	}
	if _, getErr := l.Get("cancelled-context", 0); !errors.Is(getErr, ErrMissing) {
		t.Fatalf("cancelled operation registered event: %v", getErr)
	}
}

func TestLedgerErrorCodeNeverDependsOnPersistenceText(t *testing.T) {
	repo := &usageRepositoryStub{appendErr: fmt.Errorf("secret db password")}
	l := New(WithRepository(repo))
	err := l.Register(Event{RequestID: "coded", Attempt: 0})
	if Code(err) != CodePersistence || !errors.Is(err, ErrPersistence) {
		t.Fatalf("err=%v code=%s", err, Code(err))
	}
	if strings.Contains(err.Error(), "secret db password") {
		t.Fatalf("persistence detail leaked: %v", err)
	}
}
