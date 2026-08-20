package router

import (
	"context"
	"errors"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

// attemptCoordinator owns request-local progression shared by streaming and
// non-streaming routes. Provider calls remain in Route/RouteStream because
// stream acceptance and finalization have different commit semantics.
//
// The coordinator is the sole owner of candidate acquisition, preparation,
// attempt numbering, bounded budgets, failure classification, and retry
// decisions. This keeps adapters from acquiring global retry behavior.
type attemptCoordinator struct {
	router      *Router
	req         contracts.Request
	plan        catalog.RoutePlan
	state       *attemptState
	repairState *RepairState
	execution   *AttemptContext
}

func newAttemptCoordinator(r *Router, req contracts.Request, plan catalog.RoutePlan) *attemptCoordinator {
	routeBudget := r.routeAttemptCap(len(plan.Members))
	memberBudget := r.perMember
	if memberBudget > routeBudget {
		memberBudget = routeBudget
	}
	budgets := ExecutionBudgets{Route: routeBudget, Member: memberBudget, Refresh: r.maxRefresh, Repair: r.maxRepair}
	execution, _ := NewAttemptContext(req, plan, budgets)
	return &attemptCoordinator{
		router: r, req: req, plan: plan,
		state: newAttemptState(req, plan),
		repairState: NewRepairState(req.Body, r.maxRepair, r.repairObserver),
		execution: execution,
	}
}

// attemptProgress describes one coordinator transition. A nil candidate with
// done=true is the normal terminal state (no eligible account remains).
type attemptProgress struct {
	candidate *hedgeCandidate
	failure   *Failure
	err       error
	done      bool
}

// next acquires and prepares exactly one candidate, or returns a terminal
// progression result. Preparation failures are local candidate exclusions and
// never consume route/member attempt budgets.
func (c *attemptCoordinator) next(ctx context.Context) attemptProgress {
	if c == nil || c.router == nil || c.state == nil {
		return attemptProgress{err: errors.New("proxy: attempt coordinator is unavailable")}
	}
	for c.router.overallBudgetRemains(c.state, len(c.plan.Members)) {
		if err := ctx.Err(); err != nil {
			return attemptProgress{failure: Classify(ClassifyInput{Err: err}), done: true}
		}
		c.router.skipExhaustedMembers(c.state, len(c.plan.Members))
		if c.state.memberIndex >= len(c.plan.Members) {
			c.router.applyAvailabilityHint(c.state.bestFailure, c.state.availability)
			if c.router.overallBudgetRemains(c.state, len(c.plan.Members)) && c.router.waitForAvailability(ctx, c.state.availability) {
				c.state.memberIndex = 0
				c.state.availability = Availability{}
				continue
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return attemptProgress{failure: Classify(ClassifyInput{Err: ctxErr}), done: true}
			}
			return attemptProgress{done: true}
		}

		memberIndex := c.state.memberIndex
		member := c.plan.Members[memberIndex]
		currentReq := c.state.memberRequests[memberIndex]
		lease, err := c.acquireLease(ctx, member)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return attemptProgress{failure: Classify(ClassifyInput{Err: ctxErr}), done: true}
			}
			return attemptProgress{err: err}
		}
		if lease == nil {
			// No candidate for this member is not a request failure. Advance
			// the member cursor and let the next transition try another one.
			c.state.memberIndex++
			continue
		}
		if err := ctx.Err(); err != nil {
			lease.Release()
			return attemptProgress{failure: Classify(ClassifyInput{Err: err}), done: true}
		}

		acct := lease.Account
		prepared, preparedReq, ok := c.prepare(ctx, lease, acct, member, currentReq)
		if !ok {
			continue
		}
		nextAttempt := c.state.attempts + 1
		reservation, reserveErr := c.router.reserveAttempt(ctx, preparedReq, nextAttempt)
		if reserveErr != nil {
			if prepared != nil {
				_ = prepared.Close()
			}
			lease.Release()
			return attemptProgress{err: reserveErr}
		}
		if c.execution != nil {
			if err := c.execution.BeginAttempt(memberIndex); err != nil {
				if prepared != nil {
					_ = prepared.Close()
				}
				if reservation != nil {
					_ = reservation.Release(ctx, ReleaseUnaccepted)
				}
				lease.Release()
				return attemptProgress{err: err}
			}
		}
		attempt := c.state.startAttempt(acct.ID, memberIndex)
		return attemptProgress{candidate: &hedgeCandidate{
			lease: lease, prepared: prepared, req: preparedReq,
			account: acct, member: member, memberIndex: memberIndex,
			reservation: reservation, attempt: attempt,
		}}
	}
	return attemptProgress{done: true}
}

func (c *attemptCoordinator) acquireLease(ctx context.Context, member catalog.RouteMember) (*AccountLease, error) {
	if c.state.retrySame != nil {
		retry := c.state.retrySame
		c.state.retrySame = nil
		lease, err := c.router.pool.AcquireAccount(ctx, member.ProviderID, retry.ID, member.UpstreamModelID)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, ErrNoAccount) {
			return nil, err
		}
	}
	lease, availability, err := c.router.pool.AcquireCandidate(ctx, SelectionInput{
		ProviderID: member.ProviderID, ModelID: member.UpstreamModelID,
		Surface: member.Surface, PolicyGeneration: c.plan.PolicyGeneration,
		ExcludedAccountIDs: c.state.attempted[c.state.memberIndex],
	})
	c.router.observeExclusions(c.req, c.plan, c.state.memberIndex, member, availability)
	if err == nil {
		return lease, nil
	}
	if errors.Is(err, ErrNoAccount) {
		c.state.noteAvailability(availability)
		return nil, nil
	}
	return nil, err
}

func (c *attemptCoordinator) prepare(ctx context.Context, lease *AccountLease, acct Account, member catalog.RouteMember, req contracts.Request) (*PreparedAttempt, contracts.Request, bool) {
	if c.router.preparer == nil {
		return nil, req, true
	}
	prepared, err := c.router.preparer.Prepare(ctx, acct, req)
	if err != nil || prepared == nil {
		c.router.observePreparationExclusion(c.plan, c.state.memberIndex, member)
		lease.Release()
		c.state.markAttempted(c.state.memberIndex, acct.ID)
		if err != nil {
			c.state.noteFailure(Classify(ClassifyInput{Err: errors.Join(ErrCandidatePreparation, err)}))
		} else {
			c.state.noteFailure(Classify(ClassifyInput{Err: ErrCandidatePreparation}))
		}
		return nil, req, false
	}
	c.router.pool.MarkReadiness(ReadinessRecord{
		AccountID: acct.ID, ProviderID: member.ProviderID, ModelID: member.UpstreamModelID,
		Surface: member.Surface, PolicyGeneration: c.plan.PolicyGeneration,
		Tier: ReadinessReady, CheckedAt: c.router.currentTime(),
	})
	return prepared, prepared.Request, true
}

// classify records the failed attempt and applies account/model health. The
// caller controls reservation release because a stream may own it after
// provider acceptance.
func (c *attemptCoordinator) classify(ctx context.Context, candidate *hedgeCandidate, callErr error, releaseReservation bool) (*Failure, AttemptDecision) {
	failure := c.classifyAttempt(ctx, candidate, callErr, releaseReservation)
	c.recordFailure(candidate, failure)
	if failure == nil {
		return failure, AttemptDecision{Action: RetryStop}
	}
	decision := c.router.decision(failure, c.state.refreshAllowed(candidate.account.ID, c.router.maxRefresh), c.router.retryBudgetRemains(c.state, len(c.plan.Members)))
	return failure, decision
}

func (c *attemptCoordinator) classifyAttempt(ctx context.Context, candidate *hedgeCandidate, callErr error, releaseReservation bool) *Failure {
	if candidate == nil {
		return Classify(ClassifyInput{Err: callErr})
	}
	c.state.markAttempted(candidate.memberIndex, candidate.account.ID)
	failure := c.router.classifyFailure(callErr, &candidate.account)
	if releaseReservation {
		c.router.releaseProvenUnaccepted(ctx, candidate.reservation, failure)
	}
	return failure
}

func (c *attemptCoordinator) recordFailure(candidate *hedgeCandidate, failure *Failure) {
	if candidate == nil || failure == nil {
		return
	}
	c.state.noteFailure(failure)
	c.router.applyFailureForModel(failure, &candidate.account, candidate.member.UpstreamModelID)
}

// repair attempts one compatibility repair while the current member still has
// budget. It updates the member request only when the repair was accepted.
func (c *attemptCoordinator) repair(transport any, candidate *hedgeCandidate, callErr error) (RepairEvidence, bool) {
	if candidate == nil || !c.router.currentMemberBudgetRemains(c.state, candidate.memberIndex, len(c.plan.Members)) {
		return RepairEvidence{}, false
	}
	repairedBody, evidence, accepted := proposeCompatibilityRepair(transport, c.repairState, candidate.account, c.state.memberRequests[candidate.memberIndex], callErr, c.state.attempts)
	if evidence.RuleID == "" {
		return evidence, false
	}
	c.router.observeRepair(c.req, c.plan, candidate.memberIndex, c.state.attempts, evidence, accepted)
	if !accepted {
		return evidence, false
	}
	if c.execution != nil {
		if err := c.execution.Retry(RetryScopeRepair); err != nil {
			return evidence, false
		}
	}
	c.state.memberRequests[candidate.memberIndex].Body = repairedBody
	c.state.retrySame = &candidate.account
	c.state.repairRule = evidence.RuleID
	return evidence, true
}

// retry executes only coordinator-owned refresh/failover transitions. It
// returns true when the caller should begin another provider attempt.
func (c *attemptCoordinator) retry(ctx context.Context, candidate *hedgeCandidate, decision AttemptDecision) (bool, AttemptDecision) {
	if candidate == nil {
		return false, decision
	}
	if decision.Action == RetryRefreshSameAccount {
		c.state.markRefresh(candidate.account.ID)
		if err := c.router.tryRefresh(ctx, candidate.account.ID); err == nil {
			c.router.pool.Reset(candidate.account.ID)
			_ = c.router.pool.Refresh(ctx, candidate.member.ProviderID)
			if c.router.currentMemberBudgetRemains(c.state, candidate.memberIndex, len(c.plan.Members)) {
				if c.execution != nil {
					if err := c.execution.Retry(RetryScopeRefresh); err != nil {
						return false, decision
					}
				}
				c.state.retrySame = &candidate.account
				return true, decision
			}
		} else {
			refreshFailure := c.router.classifyFailure(err, &candidate.account)
			c.state.noteFailure(refreshFailure)
			c.router.applyFailureForModel(refreshFailure, &candidate.account, candidate.member.UpstreamModelID)
			decision = c.router.decision(refreshFailure, false, c.router.retryBudgetRemains(c.state, len(c.plan.Members)))
		}
	}
	if !c.router.overallBudgetRemains(c.state, len(c.plan.Members)) {
		return false, decision
	}
	if c.execution != nil {
		if err := c.execution.Retry(RetryScopeMember); err != nil {
			return false, decision
		}
	}
	return decision.Action != RetryStop && decision.AlternateAccount, decision
}

func (c *attemptCoordinator) terminal() (*Failure, error) {
	c.router.applyAvailabilityHint(c.state.bestFailure, c.state.availability)
	if c.state.bestFailure == nil {
		if c.execution != nil {
			_ = c.execution.Terminal(AttemptOutcome{State: TerminalFailed, Err: ErrNoAccount})
		}
		return nil, ErrNoAccount
	}
	if c.execution != nil {
		_ = c.execution.Terminal(AttemptOutcome{State: TerminalFailed, Failure: c.state.bestFailure})
	}
	return c.state.bestFailure, nil
}

func (c *attemptCoordinator) complete(response *contracts.Response) {
	if c != nil && c.execution != nil {
		_ = c.execution.Terminal(AttemptOutcome{State: TerminalSucceeded, Response: response})
	}
}

// closeIfOpen gives every non-stream route exit a terminal execution record.
// Stream routes retain an accepted stream's lifecycle outside this context.
func (c *attemptCoordinator) closeIfOpen() {
	if c == nil || c.execution == nil || c.execution.State() != TerminalOpen {
		return
	}
	if c.state.bestFailure != nil {
		_ = c.execution.Terminal(AttemptOutcome{State: TerminalFailed, Failure: c.state.bestFailure})
		return
	}
	_ = c.execution.Terminal(AttemptOutcome{State: TerminalAborted, Err: ErrNoAccount})
}
