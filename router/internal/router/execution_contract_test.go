package router

import (
	"errors"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

func executionContractPlan() catalog.RoutePlan {
	return catalog.RoutePlan{
		RequestedModel: "model",
		Strategy:       catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{{
			ProviderID: "provider", ClientModelID: "model", UpstreamModelID: "model",
			Surface: contracts.SurfaceOpenAIChat,
		}},
	}
}

func newExecutionContractContext(t *testing.T, budgets ExecutionBudgets) *AttemptContext {
	t.Helper()
	ctx, err := NewAttemptContext(
		contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "model"},
		executionContractPlan(),
		budgets,
	)
	if err != nil {
		t.Fatalf("NewAttemptContext() error = %v", err)
	}
	return ctx
}

func TestExecutionBudgetsRejectInvalidValues(t *testing.T) {
	for _, budgets := range []ExecutionBudgets{
		{Route: 0},
		{Route: -1},
		{Route: 2, Member: -1},
		{Route: 2, Refresh: -1},
		{Route: 2, Repair: -1},
		{Route: 2, Member: 3},
	} {
		if err := budgets.Validate(); !errors.Is(err, ErrInvalidExecutionBudget) {
			t.Fatalf("budgets=%+v error=%v, want ErrInvalidExecutionBudget", budgets, err)
		}
	}
}

func TestAttemptContextSnapshotsPlanAndRequest(t *testing.T) {
	plan := executionContractPlan()
	req := contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat, Model: "model", Body: []byte(`{"messages":[]}`),
	}
	ctx, err := NewAttemptContext(req, plan, ExecutionBudgets{Route: 1})
	if err != nil {
		t.Fatalf("NewAttemptContext() error = %v", err)
	}
	plan.Members[0].ProviderID = "mutated"
	req.Body[0] = 'x'
	snapshot := ctx.Plan()
	if snapshot.Members[0].ProviderID != "provider" {
		t.Fatalf("plan provider = %q, want provider", snapshot.Members[0].ProviderID)
	}
	if got := ctx.Request().Body[0]; got != '{' {
		t.Fatalf("request body first byte = %q, want '{'", got)
	}
	snapshot.Members[0].ProviderID = "returned mutation"
	if got := ctx.Plan().Members[0].ProviderID; got != "provider" {
		t.Fatalf("internal plan provider = %q after returned mutation, want provider", got)
	}
}

func TestAttemptContextRejectsDoubleTerminal(t *testing.T) {
	ctx := newExecutionContractContext(t, ExecutionBudgets{Route: 1})
	if err := ctx.BeginAttempt(0); err != nil {
		t.Fatalf("BeginAttempt() error = %v", err)
	}
	outcome := AttemptOutcome{
		State:    TerminalSucceeded,
		Response: &contracts.Response{StatusCode: 200, Body: []byte(`{}`)},
	}
	if err := ctx.Terminal(outcome); err != nil {
		t.Fatalf("first Terminal() error = %v", err)
	}
	if err := ctx.Terminal(outcome); !errors.Is(err, ErrDoubleTerminal) {
		t.Fatalf("second Terminal() error = %v, want ErrDoubleTerminal", err)
	}
}

func TestAttemptContextRejectsRetryAfterClientCommit(t *testing.T) {
	ctx := newExecutionContractContext(t, ExecutionBudgets{Route: 2, Member: 2})
	if err := ctx.BeginAttempt(0); err != nil {
		t.Fatalf("BeginAttempt() error = %v", err)
	}
	if err := ctx.CommitClient(); err != nil {
		t.Fatalf("CommitClient() error = %v", err)
	}
	if err := ctx.Retry(RetryScopeMember); !errors.Is(err, ErrRetryAfterCommit) {
		t.Fatalf("Retry() error = %v, want ErrRetryAfterCommit", err)
	}
	if err := ctx.BeginAttempt(0); !errors.Is(err, ErrRetryAfterCommit) {
		t.Fatalf("BeginAttempt() error = %v, want ErrRetryAfterCommit", err)
	}
}

type executionContractLease struct {
	released int
}

func (l *executionContractLease) Release() {
	l.released++
}

func TestAttemptContextRejectsUnreleasedLeaseAtTerminal(t *testing.T) {
	ctx := newExecutionContractContext(t, ExecutionBudgets{Route: 1})
	if err := ctx.BeginAttempt(0); err != nil {
		t.Fatalf("BeginAttempt() error = %v", err)
	}
	lease := &executionContractLease{}
	if err := ctx.SetAccountLease(lease); err != nil {
		t.Fatalf("SetAccountLease() error = %v", err)
	}
	outcome := AttemptOutcome{State: TerminalFailed, Err: errors.New("provider failed")}
	if err := ctx.Terminal(outcome); !errors.Is(err, ErrLeaseNotReleased) {
		t.Fatalf("Terminal() error = %v, want ErrLeaseNotReleased", err)
	}
	ctx.ReleaseAccountLease()
	ctx.ReleaseAccountLease()
	if lease.released != 1 {
		t.Fatalf("lease releases = %d, want 1", lease.released)
	}
	networkLease := &executionContractLease{}
	if err := ctx.SetNetworkLease(networkLease); err != nil {
		t.Fatalf("SetNetworkLease() error = %v", err)
	}
	if err := ctx.Terminal(outcome); !errors.Is(err, ErrLeaseNotReleased) {
		t.Fatalf("Terminal() with network lease error = %v, want ErrLeaseNotReleased", err)
	}
	ctx.ReleaseNetworkLease()
	if networkLease.released != 1 {
		t.Fatalf("network lease releases = %d, want 1", networkLease.released)
	}
	if err := ctx.Terminal(outcome); err != nil {
		t.Fatalf("Terminal() after release error = %v", err)
	}
}
