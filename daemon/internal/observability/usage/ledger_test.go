package usage

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLedgerCodesAndRedacted(t *testing.T) {
	if Code(nil) != "" {
		t.Fatal("nil error should have empty code")
	}
	if Code(ErrDuplicate) != CodeDuplicate {
		t.Fatalf("ErrDuplicate code = %v", Code(ErrDuplicate))
	}
	if Code(errors.New("unknown")) != CodeInvalid {
		t.Fatalf("unknown error code = %v", Code(errors.New("unknown")))
	}

	e := Event{
		RequestID:        "req-1",
		LogicalRequestID: "log-1",
		IdempotencyKey:   "idem-1",
		Provider:         "openai",
		Model:            "gpt-4o",
	}
	red := e.Redacted()
	if red.RequestID != "" || red.LogicalRequestID != "" || red.IdempotencyKey != "" {
		t.Fatalf("redacted leaked IDs: %+v", red)
	}
	if red.Provider != "openai" || red.Model != "gpt-4o" {
		t.Fatalf("redacted stripped provider/model: %+v", red)
	}
}

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
	e0, err := l.Get("logical", 0)
	if err != nil || e0.Provider != "a" {
		t.Fatalf("e0=%+v err=%v", e0, err)
	}
	e1, err := l.Get("logical", 1)
	if err != nil || e1.Provider != "b" {
		t.Fatalf("e1=%+v err=%v", e1, err)
	}
}

func TestLedgerRegisterRequestAndReserve(t *testing.T) {
	l := New()
	ctx := context.Background()

	// RegisterRequest
	req := LogicalRequest{RequestID: "req-1"}
	if err := l.RegisterRequest(ctx, req); err != nil {
		t.Fatal(err)
	}
	if err := l.RegisterLogical(ctx, req); err != nil {
		t.Fatal("same request registration should be idempotent")
	}
	diffReq := LogicalRequest{RequestID: "req-1", IdempotencyKey: "different"}
	if err := l.RegisterRequest(ctx, diffReq); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("diff request should fail duplicate: %v", err)
	}

	// Register attempt and reserve
	e := Event{RequestID: "req-1", Attempt: 0, Provider: "openai"}
	if err := l.Register(e); err != nil {
		t.Fatal(err)
	}
	in := int64(100)
	resTokens := Tokens{Input: &in}
	if err := l.Reserve("req-1", 0, resTokens); err != nil {
		t.Fatal(err)
	}
	// idempotent reserve
	if err := l.Reserve("req-1", 0, resTokens); err != nil {
		t.Fatal("idempotent reserve failed")
	}

	// ReconcileQuota
	actualIn := int64(80)
	actualTokens := Tokens{Input: &actualIn}
	if err := l.ReconcileQuota("req-1", 0, actualTokens); err != nil {
		t.Fatal(err)
	}

	// CompleteRequest and GetRequest
	if err := l.CompleteRequest("req-1", "success", time.Now(), false); err != nil {
		t.Fatal(err)
	}
	lReq, err := l.GetRequest("req-1")
	if err != nil || !lReq.Completed || lReq.Outcome != "success" {
		t.Fatalf("GetRequest = %+v err=%v", lReq, err)
	}
	if _, err := l.GetRequest("missing-req"); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing request err = %v", err)
	}

	// Cancel
	e2 := Event{RequestID: "req-2", Attempt: 0}
	if err := l.Register(e2); err != nil {
		t.Fatal(err)
	}
	if err := l.Cancel("req-2", 0); err != nil {
		t.Fatal(err)
	}
	ev2, _ := l.Get("req-2", 0)
	if !ev2.Cancelled {
		t.Fatal("expected cancelled")
	}

	// Cancel with cancelled context
	cancCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := l.CancelContext(cancCtx, "req-2", 0); err == nil {
		t.Fatal("cancelled context should fail")
	}

	// Attempts
	attempts := l.Attempts("req-1")
	if len(attempts) != 1 {
		t.Fatalf("expected 1 attempt, got %d", len(attempts))
	}
	if empty := l.Attempts("missing"); len(empty) != 0 {
		t.Fatalf("expected 0 attempts, got %d", len(empty))
	}
}

func TestLedgerWithPersistenceAndValidation(t *testing.T) {
	stub := &usageRepositoryStub{}
	l := New(WithPersistence(stub))

	e := Event{RequestID: "p-req", Attempt: 0}
	if err := l.Register(e); err != nil {
		t.Fatal(err)
	}
	if stub.appends != 1 {
		t.Fatalf("appends = %d, want 1", stub.appends)
	}

	in := int64(50)
	if err := l.Reconcile("p-req", 0, Tokens{Input: &in}); err != nil {
		t.Fatal(err)
	}
	if stub.reconciles != 1 {
		t.Fatalf("reconciles = %d, want 1", stub.reconciles)
	}

	// Stub error paths
	failingStub := &usageRepositoryStub{appendErr: errors.New("db error"), reconcileErr: errors.New("db error")}
	failingLedger := New(WithRepository(failingStub))
	failEvent := Event{RequestID: "fail-req", Attempt: 0}
	if err := failingLedger.Register(failEvent); err == nil {
		t.Fatal("expected append error")
	}
	// Retrying same event when pending in persistence calls persistEvent again
	failingStub.appendErr = nil
	if err := failingLedger.Register(failEvent); err != nil {
		t.Fatalf("retry pending event failed: %v", err)
	}
	if err := failingLedger.Reconcile("fail-req", 0, Tokens{Input: &in}); err == nil {
		t.Fatal("expected reconcile error")
	}

	// Validation errors
	if err := l.Register(Event{RequestID: "", Attempt: 0}); err == nil {
		t.Fatal("empty request ID should fail")
	}
	if err := l.Register(Event{RequestID: "r", Attempt: -1}); err == nil {
		t.Fatal("negative attempt should fail")
	}
	if err := l.Reserve("missing", 0, Tokens{}); !errors.Is(err, ErrMissing) {
		t.Fatalf("reserve missing err = %v", err)
	}
	if err := l.Reconcile("missing", 0, Tokens{}); !errors.Is(err, ErrMissing) {
		t.Fatalf("reconcile missing err = %v", err)
	}

	// Cost breakdown
	l.PriceGeneration(1, Price{InputPerMillion: 2.0, OutputPerMillion: 10.0})
	l.Register(Event{RequestID: "costed", Attempt: 0, PriceGeneration: 1})
	in100 := int64(1000000)
	out50 := int64(1000000)
	l.Reconcile("costed", 0, Tokens{Input: &in100, Output: &out50})
	bd, err := l.CostBreakdown("costed", 0)
	if err != nil || bd.Amount != 12.0 {
		t.Fatalf("breakdown = %+v err=%v", bd, err)
	}
	if failures := l.PersistenceFailures(); failures != 0 {
		t.Fatalf("persistence failures = %d", failures)
	}
}
