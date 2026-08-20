package router

import (
	"errors"
	"fmt"
	"sync"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

// RetryScope identifies the owner of a retry budget. A retry is always
// accounted by the coordinator before it starts another provider call.
type RetryScope uint8

const (
	RetryScopeNone RetryScope = iota
	RetryScopeRoute
	RetryScopeMember
	RetryScopeRefresh
	RetryScopeRepair
)

func (s RetryScope) valid() bool {
	return s >= RetryScopeNone && s <= RetryScopeRepair
}

// TerminalState is the one-way state of an attempt. Client commitment is
// tracked separately: a committed attempt may still be finalized, but it can
// never be retried.
type TerminalState uint8

const (
	TerminalOpen TerminalState = iota
	TerminalSucceeded
	TerminalFailed
	TerminalAborted
)

func (s TerminalState) terminal() bool {
	return s == TerminalSucceeded || s == TerminalFailed || s == TerminalAborted
}

var (
	ErrInvalidExecutionBudget = errors.New("proxy: invalid execution budget")
	ErrExecutionBudgetExhausted = errors.New("proxy: execution budget exhausted")
	ErrAttemptTerminal = errors.New("proxy: attempt is already terminal")
	ErrDoubleTerminal = errors.New("proxy: attempt terminal state already closed")
	ErrRetryAfterCommit = errors.New("proxy: retry after client commit")
	ErrLeaseNotReleased = errors.New("proxy: attempt lease was not released")
	ErrInvalidAttemptOutcome = errors.New("proxy: invalid attempt outcome")
	ErrInvalidRetryScope = errors.New("proxy: invalid retry scope")
)

// ExecutionBudgets is immutable request-local accounting. Member == 0 means
// that the route-wide budget is the only attempt budget, matching legacy
// router configuration.
type ExecutionBudgets struct {
	Route   int
	Member  int
	Refresh int
	Repair  int
}

func (b ExecutionBudgets) Validate() error {
	if b.Route <= 0 || b.Member < 0 || b.Refresh < 0 || b.Repair < 0 {
		return fmt.Errorf("%w: route=%d member=%d refresh=%d repair=%d", ErrInvalidExecutionBudget, b.Route, b.Member, b.Refresh, b.Repair)
	}
	if b.Member > b.Route {
		return fmt.Errorf("%w: member budget %d exceeds route budget %d", ErrInvalidExecutionBudget, b.Member, b.Route)
	}
	return nil
}

// ExecutionLease is implemented by both account and admission/network
// leases. Release must be idempotent; ownership remains with the attempt
// context until ReleaseAccountLease/ReleaseNetworkLease is called.
type ExecutionLease interface {
	Release()
}

type executionLease struct {
	lease    ExecutionLease
	released bool
}

// AttemptContext is the shared mutable execution authority for one route
// attempt sequence. The catalog plan and request are defensively copied at
// construction and can only be observed through copies.
type AttemptContext struct {
	mu       sync.Mutex
	plan     catalog.RoutePlan
	request  contracts.Request
	budgets  ExecutionBudgets
	state    TerminalState
	committed bool
	retry    RetryScope
	attempts int
	memberAttempts map[int]int
	refreshes int
	repairs   int
	accountLease *executionLease
	networkLease *executionLease
}

// AttemptOutcome is the coordinator's final decision for one attempt
// sequence. Retry must be RetryScopeNone when the outcome is terminal.
type AttemptOutcome struct {
	State    TerminalState
	Response *contracts.Response
	Failure  *Failure
	Err      error
	Retry    RetryScope
}

func (o AttemptOutcome) Validate() error {
	if !o.State.terminal() || !o.Retry.valid() || o.Retry != RetryScopeNone {
		return fmt.Errorf("%w: terminal state=%d retry=%d", ErrInvalidAttemptOutcome, o.State, o.Retry)
	}
	switch o.State {
	case TerminalSucceeded:
		if o.Response == nil || o.Failure != nil || o.Err != nil {
			return fmt.Errorf("%w: success requires response without failure", ErrInvalidAttemptOutcome)
		}
	case TerminalFailed, TerminalAborted:
		if o.Response != nil || (o.Err == nil && o.Failure == nil) {
			return fmt.Errorf("%w: failed outcome requires failure or error", ErrInvalidAttemptOutcome)
		}
	}
	return nil
}

// NewAttemptContext validates and snapshots a route plan for coordinator
// consumption. catalog.RoutePlan remains the sole route-plan type.
func NewAttemptContext(req contracts.Request, plan catalog.RoutePlan, budgets ExecutionBudgets) (*AttemptContext, error) {
	if err := budgets.Validate(); err != nil {
		return nil, err
	}
	if err := validateRoutePlan(req, plan); err != nil {
		return nil, err
	}
	req.Headers = req.Headers.Clone()
	req.Body = append([]byte(nil), req.Body...)
	return &AttemptContext{
		plan: cloneExecutionPlan(plan),
		request: req,
		budgets: budgets,
		state: TerminalOpen,
		memberAttempts: make(map[int]int, len(plan.Members)),
	}, nil
}

func (c *AttemptContext) Plan() catalog.RoutePlan {
	if c == nil {
		return catalog.RoutePlan{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneExecutionPlan(c.plan)
}

func (c *AttemptContext) Request() contracts.Request {
	if c == nil {
		return contracts.Request{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	req := c.request
	req.Headers = req.Headers.Clone()
	req.Body = append([]byte(nil), req.Body...)
	return req
}

func (c *AttemptContext) Budgets() ExecutionBudgets {
	if c == nil {
		return ExecutionBudgets{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.budgets
}

func (c *AttemptContext) State() TerminalState {
	if c == nil {
		return TerminalAborted
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

func (c *AttemptContext) Committed() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.committed
}

// BeginAttempt accounts one provider attempt against route and member
// budgets. memberIndex is the immutable catalog member index.
func (c *AttemptContext) BeginAttempt(memberIndex int) error {
	if c == nil {
		return ErrAttemptTerminal
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != TerminalOpen {
		return ErrAttemptTerminal
	}
	if c.committed {
		return ErrRetryAfterCommit
	}
	if memberIndex < 0 || memberIndex >= len(c.plan.Members) {
		return fmt.Errorf("%w: member index %d", ErrInvalidAttemptOutcome, memberIndex)
	}
	if c.attempts >= c.budgets.Route {
		return ErrExecutionBudgetExhausted
	}
	if c.budgets.Member > 0 && c.memberAttempts[memberIndex] >= c.budgets.Member {
		return ErrExecutionBudgetExhausted
	}
	c.attempts++
	c.memberAttempts[memberIndex]++
	c.retry = RetryScopeNone
	return nil
}

// Retry records a retry decision without starting it. BeginAttempt must be
// called before the next provider call, which enforces route/member budgets.
func (c *AttemptContext) Retry(scope RetryScope) error {
	if c == nil {
		return ErrAttemptTerminal
	}
	if !scope.valid() || scope == RetryScopeNone {
		return ErrInvalidRetryScope
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != TerminalOpen {
		return ErrAttemptTerminal
	}
	if c.committed {
		return ErrRetryAfterCommit
	}
	switch scope {
	case RetryScopeRefresh:
		if c.refreshes >= c.budgets.Refresh {
			return ErrExecutionBudgetExhausted
		}
		c.refreshes++
	case RetryScopeRepair:
		if c.repairs >= c.budgets.Repair {
			return ErrExecutionBudgetExhausted
		}
		c.repairs++
	}
	c.retry = scope
	return nil
}

func (c *AttemptContext) RetryScope() RetryScope {
	if c == nil {
		return RetryScopeNone
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.retry
}

// CommitClient is the irreversible client-visible commit point. Once called,
// Retry and BeginAttempt reject all further attempts.
func (c *AttemptContext) CommitClient() error {
	if c == nil {
		return ErrAttemptTerminal
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != TerminalOpen {
		return ErrAttemptTerminal
	}
	if c.committed {
		return nil
	}
	c.committed = true
	return nil
}

func (c *AttemptContext) SetAccountLease(lease ExecutionLease) error {
	if c == nil {
		return ErrAttemptTerminal
	}
	return c.setLease(&c.accountLease, lease)
}

func (c *AttemptContext) SetNetworkLease(lease ExecutionLease) error {
	if c == nil {
		return ErrAttemptTerminal
	}
	return c.setLease(&c.networkLease, lease)
}

func (c *AttemptContext) setLease(dst **executionLease, lease ExecutionLease) error {
	if c == nil || lease == nil {
		return ErrLeaseNotReleased
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != TerminalOpen {
		return ErrAttemptTerminal
	}
	if c.committed {
		return ErrRetryAfterCommit
	}
	if *dst != nil && !(*dst).released {
		return ErrLeaseNotReleased
	}
	*dst = &executionLease{lease: lease}
	return nil
}

func (c *AttemptContext) ReleaseAccountLease() {
	if c == nil {
		return
	}
	c.mu.Lock()
	lease := c.accountLease
	releaseNow := false
	if lease != nil && !lease.released {
		lease.released = true
		releaseNow = true
	}
	c.mu.Unlock()
	if releaseNow {
		lease.lease.Release()
	}
}

func (c *AttemptContext) ReleaseNetworkLease() {
	if c == nil {
		return
	}
	c.mu.Lock()
	lease := c.networkLease
	releaseNow := false
	if lease != nil && !lease.released {
		lease.released = true
		releaseNow = true
	}
	c.mu.Unlock()
	if releaseNow {
		lease.lease.Release()
	}
}

// TransferAccountLease removes account-lease ownership from the attempt so a
// returned stream can own and finalize it.
func (c *AttemptContext) TransferAccountLease() ExecutionLease {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accountLease == nil || c.accountLease.released {
		return nil
	}
	lease := c.accountLease.lease
	c.accountLease = nil
	return lease
}

// TransferNetworkLease removes network/admission ownership from the attempt
// so a stream or downstream lifecycle can own and finalize it.
func (c *AttemptContext) TransferNetworkLease() ExecutionLease {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.networkLease == nil || c.networkLease.released {
		return nil
	}
	lease := c.networkLease.lease
	c.networkLease = nil
	return lease
}

func (c *AttemptContext) leasesReleasedLocked() bool {
	return (c.accountLease == nil || c.accountLease.released) && (c.networkLease == nil || c.networkLease.released)
}

// Terminal closes the attempt exactly once. A terminal outcome cannot carry a
// retry and all account/network leases must have been released or transferred
// before closure.
func (c *AttemptContext) Terminal(outcome AttemptOutcome) error {
	if c == nil {
		return ErrDoubleTerminal
	}
	if err := outcome.Validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != TerminalOpen {
		return ErrDoubleTerminal
	}
	if !c.leasesReleasedLocked() {
		return ErrLeaseNotReleased
	}
	c.state = outcome.State
	return nil
}

func cloneExecutionPlan(plan catalog.RoutePlan) catalog.RoutePlan {
	clone := plan
	clone.Members = append([]catalog.RouteMember(nil), plan.Members...)
	clone.Requirements.Hard = append([]catalog.FeatureRequirement(nil), plan.Requirements.Hard...)
	clone.Requirements.Soft = append([]catalog.FeatureRequirement(nil), plan.Requirements.Soft...)
	clone.Requirements.ToolKinds = append([]transforms.ToolKind(nil), plan.Requirements.ToolKinds...)
	clone.Requirements.ReferenceKinds = append([]string(nil), plan.Requirements.ReferenceKinds...)
	if len(plan.Exclusions) != 0 {
		clone.Exclusions = make([]catalog.RouteExclusion, len(plan.Exclusions))
		copy(clone.Exclusions, plan.Exclusions)
		for i := range clone.Exclusions {
			clone.Exclusions[i].Supported = append([]string(nil), plan.Exclusions[i].Supported...)
		}
	}
	if plan.CanonicalOperation.Compaction != nil {
		if operation, err := transforms.NewCompactionRequest(*plan.CanonicalOperation.Compaction); err == nil {
			clone.CanonicalOperation.Compaction = operation
		} else {
			compaction := *plan.CanonicalOperation.Compaction
			clone.CanonicalOperation.Compaction = &compaction
		}
	}
	return clone
}
