// File: router.go
// AD-3 retry loop. The Router drives the per-attempt failover between
// accounts. It depends only on provider/transport interfaces and the pool;
// concrete HTTP providers, transforms, and middleware live outside this
// package.
package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

// Transport executes one provider call against an account. It is the
// integration point between the router and the transport package; the
// transport is expected to surface ClassifyInput-friendly signals when it
// returns an error.
type Transport interface {
	// Call performs the request. On a non-nil error, the router treats
	// it as a classified failure. On success the response is forwarded
	// to the caller.
	Call(ctx context.Context, acct Account, req contracts.Request) (*contracts.Response, error)
}

// StreamTransport is the streaming variant of Transport. It returns an
// iterator the router can drain until completion or cancellation. The
// router never assumes the iterator is safe for concurrent access; it
// always drains on the calling goroutine.
type StreamTransport interface {
	CallStream(ctx context.Context, acct Account, req contracts.Request) (*Stream, error)
}

// CredentialRefresher is consulted when the router decides an account
// needs a credential refresh. Implementations are responsible for throttling
// concurrent refreshes per account.
type CredentialRefresher interface {
	Refresh(ctx context.Context, accountID string) error
}

// RetryAction is the only action the bounded coordinator can execute after
// classifying an attempt.
type RetryAction string

const (
	RetryStop               RetryAction = "stop"
	RetryRefreshSameAccount RetryAction = "refresh-and-retry-same-account"
	RetryRepairSameAccount  RetryAction = "repair-and-retry-same-account"
	RetryNextAccount        RetryAction = "retry-next-account"
	RetryBackoffNextAccount RetryAction = "backoff-and-retry"
)

// AttemptDecision contains typed, bounded retry metadata.
type AttemptDecision struct {
	Action           RetryAction
	Code             string
	Phase            FailurePhase
	Scope            FailureScope
	RetryAfter       time.Duration
	AlternateAccount bool
	RefreshAllowed   bool
}

// RouterConfig configures the Router.
type RouterConfig struct {
	Pool *AccountPool
	// MaxAttempts caps total attempts per request when per-member budgeting
	// is not enabled (see MaxAttemptsPerMember).
	MaxAttempts int
	// MaxAttemptsPerMember switches the retry budget from one route-wide
	// counter to a per-member budget: every fallback member of the route
	// plan may consume up to MaxAttemptsPerMember attempts of its own, so a
	// combination route no longer shares a single budget across members.
	//
	// Semantics:
	//   - Non-positive keeps the legacy behaviour: MaxAttempts is one global
	//     budget shared by every member of the route (a 3-member combo with
	//     MaxAttempts=3 gets ~1 attempt per member).
	//   - Positive enables per-member budgeting. The route-wide worst case
	//     stays bounded: total attempts are capped at
	//     min(MaxAttemptsPerMember*len(members), MaxRouteAttempts), so a
	//     catalog generation listing many members cannot multiply the budget
	//     without bound. MaxAttempts is ignored while per-member budgeting is
	//     active; reservation attempt numbering stays global (1..cap) so the
	//     token-budget authority still sees unique attempt keys.
	MaxAttemptsPerMember int
	// EnableHedging opts into one delayed alternate attempt for eligible
	// idempotent non-streaming requests. It is deliberately disabled by
	// default; provider policy and request semantics are checked as well.
	EnableHedging bool
	// HedgeEnabled is an explicit alias retained for callers that use the
	// policy vocabulary. Either enable field opts in; both default to false.
	HedgeEnabled bool
	// HedgeDelay is the bounded grace period given to the first attempt before
	// preparing an alternate candidate.
	HedgeDelay time.Duration
	// MaxHedges bounds additional concurrent attempts. The Router currently
	// supports at most one extra attempt per request.
	MaxHedges         int
	Observer          observability.AttemptObserver
	MaxRepairAttempts int
	RepairObserver    RepairObserver
	// MaxRefreshAttempts bounds same-account refresh retries. Non-positive
	// defaults to one refresh per request/account.
	MaxRefreshAttempts int
	Refresher          CredentialRefresher
	Now                func() time.Time
	// RetryWaitMax bounds a wait for an unavailable candidate. Non-positive
	// values use DefaultRetryWaitMax.
	RetryWaitMax time.Duration
	// Wait is an injectable, context-aware timer seam used by deterministic
	// router tests. Nil uses a real timer.
	Wait func(context.Context, time.Duration) bool
	// DefaultOutputCap is reserved when a normalized request omits an explicit
	// output cap. Non-positive values use the contract maximum.
	DefaultOutputCap int64
	// Preparer performs bounded local candidate preparation before an upstream
	// attempt is counted. Nil preserves the legacy direct transport path.
	Preparer CandidatePreparer
}

const (
	DefaultMaxAttempts        = 3
	DefaultMaxRefreshAttempts = 1
	DefaultRetryWaitMax       = 5 * time.Second
	DefaultHedgeDelay         = 50 * time.Millisecond
	MaxHedgeDelay             = 5 * time.Second
	DefaultMaxHedges          = 1
	MaxHedgesPerRequest       = 1
	// DefaultMaxAttemptsPerMember is the per-member retry budget bootstrap
	// opts into for combination routes.
	DefaultMaxAttemptsPerMember = 3
	// MaxRouteAttempts is the hard route-wide ceiling used when per-member
	// budgeting is enabled. It bounds the worst case regardless of how many
	// members a catalog generation lists (catalog.MaxComboMembers is 64, so
	// per-member budgets alone would allow far more).
	MaxRouteAttempts = 16
)

// Router drives one bounded coordinator per request.
type Router struct {
	pool                     *AccountPool
	max                      int
	perMember                int
	maxRefresh               int
	maxRepair                int
	observer                 observability.AttemptObserver
	repairObserver           RepairObserver
	refresher                CredentialRefresher
	now                      func() time.Time
	retryWaitMax             time.Duration
	wait                     func(context.Context, time.Duration) bool
	defaultOutputCap         int64
	preparer                 CandidatePreparer
	hedgeEnabled             bool
	hedgeDelay               time.Duration
	maxHedges                int
	nowMu                    sync.Mutex
	quotaPersistenceFailures atomic.Uint64
}

// attemptState is the request-local authority for transitions that are
// identical between Route and RouteStream. The shared contract is bounded
// candidate exclusion/acquisition input, prepared member requests, quota
// reservation numbering, attempt/account bookkeeping, failure preservation,
// refresh accounting, availability hints, and retry ownership. It deliberately
// owns bookkeeping only: stream preflight/acceptance, cancellation, terminal
// event ownership, and finalization plus non-stream response acceptance remain
// explicit in their respective loops.
type attemptState struct {
	attempted        []map[string]struct{}
	memberRequests   []contracts.Request
	memberAttempts   []int
	refreshes        map[string]int
	refreshBudget    int
	bestFailure      *Failure
	availability     Availability
	memberIndex      int
	attempts         int
	firstAccountID   string
	firstMemberIndex int
	retrySame        *Account
	repairRule       string
}

func newAttemptState(req contracts.Request, plan catalog.RoutePlan) *attemptState {
	attempted, memberRequests := prepareMembers(req, plan)
	return &attemptState{
		attempted: attempted, memberRequests: memberRequests, memberAttempts: make([]int, len(attempted)),
		refreshes: make(map[string]int), firstMemberIndex: -1,
	}
}

func (s *attemptState) markAttempted(memberIndex int, accountID string) {
	if s == nil || memberIndex < 0 || memberIndex >= len(s.attempted) || accountID == "" {
		return
	}
	s.attempted[memberIndex][accountID] = struct{}{}
}

func (s *attemptState) noteAvailability(availability Availability) {
	if s == nil {
		return
	}
	s.availability = earlierAvailability(s.availability, availability)
}

func (s *attemptState) startAttempt(accountID string, memberIndex int) int {
	if s == nil {
		return 0
	}
	s.attempts++
	s.noteMemberAttempt(memberIndex)
	if s.firstAccountID == "" {
		s.firstAccountID, s.firstMemberIndex = accountID, memberIndex
	}
	return s.attempts
}

// noteMemberAttempt records one attempt against a member's per-member budget.
func (s *attemptState) noteMemberAttempt(memberIndex int) {
	if s == nil || memberIndex < 0 || memberIndex >= len(s.memberAttempts) {
		return
	}
	s.memberAttempts[memberIndex]++
}

func (s *attemptState) noteFailure(failure *Failure) {
	if s == nil {
		return
	}
	s.bestFailure = preserveActionableFailure(s.bestFailure, failure)
}

func (s *attemptState) refreshAllowed(accountID string, max int) bool {
	return s != nil && s.refreshBudget < max && s.refreshes[accountID] == 0
}

func (s *attemptState) markRefresh(accountID string) {
	if s == nil {
		return
	}
	s.refreshes[accountID]++
	s.refreshBudget++
}

func (s *attemptState) failover(accountID string, memberIndex int) bool {
	return s != nil && s.attempts > 1 && (accountID != s.firstAccountID || memberIndex != s.firstMemberIndex)
}

// routeAttemptCap returns the route-wide attempt ceiling for a plan with
// memberCount members. Legacy budgeting uses MaxAttempts as one shared
// counter; per-member budgeting allows up to perMember attempts per member,
// clamped by MaxRouteAttempts so the worst case stays bounded.
func (r *Router) routeAttemptCap(memberCount int) int {
	if r == nil || r.perMember <= 0 {
		if r == nil {
			return DefaultMaxAttempts
		}
		return r.max
	}
	routeCap := r.perMember * memberCount
	if routeCap > MaxRouteAttempts {
		routeCap = MaxRouteAttempts
	}
	if routeCap < 1 {
		routeCap = 1
	}
	return routeCap
}

// overallBudgetRemains reports whether the route-wide cap still allows
// another attempt.
func (r *Router) overallBudgetRemains(state *attemptState, memberCount int) bool {
	return state != nil && state.attempts < r.routeAttemptCap(memberCount)
}

// memberBudgetExhausted reports whether one member has consumed its whole
// per-member budget. It is always false in legacy (global-budget) mode.
func (r *Router) memberBudgetExhausted(state *attemptState, memberIndex int) bool {
	if r == nil || r.perMember <= 0 || state == nil {
		return false
	}
	return memberIndex >= 0 && memberIndex < len(state.memberAttempts) && state.memberAttempts[memberIndex] >= r.perMember
}

// skipExhaustedMembers advances the member cursor past members whose
// per-member budget is spent so the next acquisition happens on a member
// that can still accept an attempt.
func (r *Router) skipExhaustedMembers(state *attemptState, memberCount int) {
	for state.memberIndex < memberCount && r.memberBudgetExhausted(state, state.memberIndex) {
		state.memberIndex++
	}
}

// retryBudgetRemains reports whether any attempt budget remains for the rest
// of the route: the route-wide cap plus, in per-member mode, the current or
// any later member.
func (r *Router) retryBudgetRemains(state *attemptState, memberCount int) bool {
	if !r.overallBudgetRemains(state, memberCount) {
		return false
	}
	if r.perMember <= 0 {
		return true
	}
	for i := state.memberIndex; i < len(state.memberAttempts) && i < memberCount; i++ {
		if state.memberAttempts[i] < r.perMember {
			return true
		}
	}
	return false
}

// currentMemberBudgetRemains reports whether the member at memberIndex can
// accept another attempt. Legacy mode falls back to the global counter.
func (r *Router) currentMemberBudgetRemains(state *attemptState, memberIndex, memberCount int) bool {
	if r == nil || r.perMember <= 0 {
		return r.overallBudgetRemains(state, memberCount)
	}
	return r.overallBudgetRemains(state, memberCount) && !r.memberBudgetExhausted(state, memberIndex)
}

func (r *Router) currentTime() time.Time {
	if r == nil || r.now == nil {
		return time.Now()
	}
	r.nowMu.Lock()
	now := r.now()
	r.nowMu.Unlock()
	return now
}

func NewRouter(cfg RouterConfig) (*Router, error) {
	if cfg.Pool == nil {
		return nil, errors.New("proxy: router account pool is required")
	}
	max := cfg.MaxAttempts
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	perMember := cfg.MaxAttemptsPerMember
	if perMember < 0 {
		perMember = 0
	}
	maxRefresh := cfg.MaxRefreshAttempts
	if maxRefresh <= 0 {
		maxRefresh = DefaultMaxRefreshAttempts
	}
	maxRepair := cfg.MaxRepairAttempts
	if maxRepair <= 0 {
		maxRepair = DefaultMaxRepairAttempts
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	retryWaitMax := cfg.RetryWaitMax
	if retryWaitMax <= 0 {
		retryWaitMax = DefaultRetryWaitMax
	}
	hedgeDelay := cfg.HedgeDelay
	if hedgeDelay <= 0 {
		hedgeDelay = DefaultHedgeDelay
	}
	if hedgeDelay > MaxHedgeDelay {
		hedgeDelay = MaxHedgeDelay
	}
	maxHedges := cfg.MaxHedges
	if maxHedges <= 0 {
		maxHedges = DefaultMaxHedges
	}
	if maxHedges > MaxHedgesPerRequest {
		maxHedges = MaxHedgesPerRequest
	}
	wait := cfg.Wait
	if wait == nil {
		wait = waitWithTimer
	}
	defaultOutputCap := cfg.DefaultOutputCap
	if defaultOutputCap <= 0 || defaultOutputCap > tokenbudget.MaxTokenCount {
		defaultOutputCap = int64(contracts.MaxOutputTokenCount)
	}
	return &Router{
		pool: cfg.Pool, max: max, perMember: perMember, maxRefresh: maxRefresh, maxRepair: maxRepair, observer: cfg.Observer, repairObserver: cfg.RepairObserver,
		refresher: cfg.Refresher, now: now, retryWaitMax: retryWaitMax, wait: wait, defaultOutputCap: defaultOutputCap,
		preparer: cfg.Preparer, hedgeEnabled: cfg.EnableHedging || cfg.HedgeEnabled, hedgeDelay: hedgeDelay, maxHedges: maxHedges,
	}, nil
}

// Route executes one global-deadline, bounded non-streaming attempt state
// machine. Account selection excludes every prior account except an explicit
// refresh retry of the same account.
func (r *Router) Route(ctx context.Context, transport Transport, req contracts.Request, plan catalog.RoutePlan) (*contracts.Response, *Failure, error) {
	if transport == nil {
		return nil, nil, errors.New("proxy: nil transport")
	}
	if ctx == nil {
		return nil, nil, errors.New("proxy: nil context")
	}
	if err := validateRoutePlan(req, plan); err != nil {
		return nil, nil, err
	}
	state := newAttemptState(req, plan)
	repairState := NewRepairState(req.Body, r.maxRepair, r.repairObserver)
	hedges := 0
	defer func() { r.observeRequestAttempts(state.attempts) }()

	for r.overallBudgetRemains(state, len(plan.Members)) {
		if err := ctx.Err(); err != nil {
			return nil, Classify(ClassifyInput{Err: err}), nil
		}
		r.skipExhaustedMembers(state, len(plan.Members))
		if state.memberIndex >= len(plan.Members) {
			r.applyAvailabilityHint(state.bestFailure, state.availability)
			if r.overallBudgetRemains(state, len(plan.Members)) && r.waitForAvailability(ctx, state.availability) {
				state.memberIndex = 0
				state.availability = Availability{}
				continue
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, Classify(ClassifyInput{Err: ctxErr}), nil
			}
			break
		}
		member := plan.Members[state.memberIndex]
		currentReq := state.memberRequests[state.memberIndex]
		var lease *AccountLease
		if state.retrySame != nil {
			var err error
			lease, err = r.pool.AcquireAccount(ctx, member.ProviderID, state.retrySame.ID, member.UpstreamModelID)
			state.retrySame = nil
			if err != nil && !errors.Is(err, ErrNoAccount) {
				if ctxErr := ctx.Err(); ctxErr != nil {
					return nil, Classify(ClassifyInput{Err: ctxErr}), nil
				}
				return nil, nil, err
			}
		}
		if lease == nil {
			var availability Availability
			var err error
			lease, availability, err = r.pool.AcquireCandidate(ctx, SelectionInput{ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, ExcludedAccountIDs: state.attempted[state.memberIndex]})
			r.observeExclusions(req, plan, state.memberIndex, member, availability)
			if err != nil {
				if errors.Is(err, ErrNoAccount) {
					state.noteAvailability(availability)
					if ctxErr := ctx.Err(); ctxErr != nil {
						return nil, Classify(ClassifyInput{Err: ctxErr}), nil
					}
					state.memberIndex++
					continue
				}
				if ctxErr := ctx.Err(); ctxErr != nil {
					return nil, Classify(ClassifyInput{Err: ctxErr}), nil
				}
				return nil, nil, err
			}
		}
		if err := ctx.Err(); err != nil {
			lease.Release()
			return nil, Classify(ClassifyInput{Err: err}), nil
		}
		acct := lease.Account
		prepared := (*PreparedAttempt)(nil)
		preparedReq := currentReq
		if r.preparer != nil {
			var prepareErr error
			prepared, prepareErr = r.preparer.Prepare(ctx, acct, currentReq)
			if prepareErr != nil {
				r.observePreparationExclusion(plan, state.memberIndex, member)
				lease.Release()
				state.markAttempted(state.memberIndex, acct.ID)
				state.noteFailure(Classify(ClassifyInput{Err: errors.Join(ErrCandidatePreparation, prepareErr)}))
				continue
			}
			if prepared == nil {
				r.observePreparationExclusion(plan, state.memberIndex, member)
				lease.Release()
				state.markAttempted(state.memberIndex, acct.ID)
				state.noteFailure(Classify(ClassifyInput{Err: ErrCandidatePreparation}))
				continue
			}
			preparedReq = prepared.Request
			r.pool.MarkReadiness(ReadinessRecord{AccountID: acct.ID, ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, Tier: ReadinessReady, CheckedAt: r.currentTime()})
		}
		nextAttempt := state.attempts + 1
		reservation, reserveErr := r.reserveAttempt(ctx, preparedReq, nextAttempt)
		if reserveErr != nil {
			if prepared != nil {
				_ = prepared.Close()
			}
			lease.Release()
			return nil, nil, reserveErr
		}
		state.startAttempt(acct.ID, state.memberIndex)
		candidate := &hedgeCandidate{lease: lease, prepared: prepared, req: preparedReq, account: acct, member: member, memberIndex: state.memberIndex, reservation: reservation, attempt: state.attempts}
		var resp *contracts.Response
		var callErr error
		startedAt, endedAt := r.currentTime().UTC(), r.currentTime().UTC()
		var network attemptNetworkSnapshot
		if hedges < r.maxHedges && state.attempts == 1 && r.hedgeEligible(req, plan) {
			outcome, hedged := r.executeHedge(ctx, transport, req, candidate, state, state.memberRequests, plan)
			if hedged {
				hedges++
				state.attempts++
			}
			candidate = outcome.candidate
			acct, member, state.memberIndex, preparedReq, reservation = candidate.account, candidate.member, candidate.memberIndex, candidate.req, candidate.reservation
			resp, callErr = outcome.resp, outcome.err
			startedAt, endedAt, network = outcome.startedAt, outcome.endedAt, outcome.network
		} else {
			startedAt = r.currentTime().UTC()
			attemptCtx, attemptNetwork := withAttemptNetworkEvidence(ctx)
			resp, callErr = callAttempt(attemptCtx, transport, lease, preparedReq)
			if prepared != nil {
				_ = prepared.Close()
			}
			endedAt = r.currentTime().UTC()
			network = attemptNetwork.snapshot()
		}
		evidence := r.attemptEvidence(req, plan, state.memberIndex, member, acct, network, state.attempts, state.repairRule, startedAt, endedAt)
		if callErr == nil && resp == nil {
			callErr = ErrNilAttemptResponse
		}
		if callErr == nil {
			attemptUsage := parseAttemptUsage(resp)
			evidence.Result = observability.AttemptSucceeded
			evidence.Usage = attemptTokenUsage(attemptUsage)
			evidence.Failover = state.failover(acct.ID, state.memberIndex)
			r.observeAttempt(evidence)
			if reservation != nil {
				if reconcileErr := reservation.Reconcile(ctx, attemptUsage); reconcileErr != nil {
					r.quotaPersistenceFailures.Add(1)
				}
			}
			return resp, nil, nil
		}
		state.markAttempted(state.memberIndex, acct.ID)
		failure := r.classifyFailure(callErr, &acct)
		r.releaseProvenUnaccepted(ctx, reservation, failure)
		if r.currentMemberBudgetRemains(state, state.memberIndex, len(plan.Members)) {
			if repairedBody, repair, accepted := proposeCompatibilityRepair(transport, repairState, acct, currentReq, callErr, state.attempts); repair.RuleID != "" {
				r.observeRepair(req, plan, state.memberIndex, state.attempts, repair, accepted)
				if accepted {
					evidence.Result = observability.AttemptFailed
					evidence.Code, evidence.Scope, evidence.Phase = failure.Code, string(failure.Scope), string(failure.Phase)
					evidence.RetryAction = string(RetryRepairSameAccount)
					evidence.RepairRule = repair.RuleID
					r.observeAttempt(evidence)
					state.memberRequests[state.memberIndex].Body = repairedBody
					state.retrySame = &acct
					state.repairRule = repair.RuleID
					continue
				}
			}
		}
		state.repairRule = ""
		state.noteFailure(failure)
		r.applyFailureForModel(failure, &acct, member.UpstreamModelID)
		decision := r.decision(failure, state.refreshAllowed(acct.ID, r.maxRefresh), r.retryBudgetRemains(state, len(plan.Members)))
		evidence.Result = observability.AttemptFailed
		evidence.Code, evidence.Scope, evidence.Phase = failure.Code, string(failure.Scope), string(failure.Phase)
		evidence.RetryAction = string(decision.Action)
		evidence.RetryAfterMS = decision.RetryAfter.Milliseconds()
		r.observeAttempt(evidence)
		if !failure.Retryable || !failure.AlternateAccountEligible {
			return nil, failure, nil
		}
		if decision.Action == RetryRefreshSameAccount {
			state.markRefresh(acct.ID)
			if err := r.tryRefresh(ctx, acct.ID); err == nil {
				r.pool.Reset(acct.ID)
				_ = r.pool.Refresh(ctx, member.ProviderID)
				// A same-account refresh retry spends the current member's
				// budget; skip it when that member is already exhausted so
				// the loop advances to the next member instead.
				if r.currentMemberBudgetRemains(state, state.memberIndex, len(plan.Members)) {
					state.retrySame = &acct
					continue
				}
			} else {
				refreshFailure := r.classifyFailure(err, &acct)
				state.noteFailure(refreshFailure)
				r.applyFailureForModel(refreshFailure, &acct, member.UpstreamModelID)
				decision = r.decision(refreshFailure, false, r.retryBudgetRemains(state, len(plan.Members)))
			}
		}
		if !r.overallBudgetRemains(state, len(plan.Members)) {
			break
		}
		if decision.Action == RetryStop || !decision.AlternateAccount {
			return nil, state.bestFailure, nil
		}
	}
	r.applyAvailabilityHint(state.bestFailure, state.availability)
	if state.bestFailure == nil {
		return nil, nil, ErrNoAccount
	}
	return nil, state.bestFailure, nil
}

func (r *Router) RouteStream(ctx context.Context, transport StreamTransport, req contracts.Request, plan catalog.RoutePlan) (*Stream, string, *Failure, error) {
	if transport == nil {
		return nil, "", nil, errors.New("proxy: nil stream transport")
	}
	if ctx == nil {
		return nil, "", nil, errors.New("proxy: nil context")
	}
	if err := validateRoutePlan(req, plan); err != nil {
		return nil, "", nil, err
	}
	state := newAttemptState(req, plan)
	repairState := NewRepairState(req.Body, r.maxRepair, r.repairObserver)
	defer func() { r.observeRequestAttempts(state.attempts) }()
	for r.overallBudgetRemains(state, len(plan.Members)) {
		if err := ctx.Err(); err != nil {
			return nil, "", Classify(ClassifyInput{Err: err}), nil
		}
		r.skipExhaustedMembers(state, len(plan.Members))
		if state.memberIndex >= len(plan.Members) {
			r.applyAvailabilityHint(state.bestFailure, state.availability)
			if r.overallBudgetRemains(state, len(plan.Members)) && r.waitForAvailability(ctx, state.availability) {
				state.memberIndex = 0
				state.availability = Availability{}
				continue
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, "", Classify(ClassifyInput{Err: ctxErr}), nil
			}
			break
		}
		member := plan.Members[state.memberIndex]
		currentReq := state.memberRequests[state.memberIndex]
		var lease *AccountLease
		if state.retrySame != nil {
			var err error
			lease, err = r.pool.AcquireAccount(ctx, member.ProviderID, state.retrySame.ID, member.UpstreamModelID)
			state.retrySame = nil
			if err != nil && !errors.Is(err, ErrNoAccount) {
				if ctxErr := ctx.Err(); ctxErr != nil {
					return nil, "", Classify(ClassifyInput{Err: ctxErr}), nil
				}
				return nil, "", nil, err
			}
		}
		if lease == nil {
			var availability Availability
			var err error
			lease, availability, err = r.pool.AcquireCandidate(ctx, SelectionInput{ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, ExcludedAccountIDs: state.attempted[state.memberIndex]})
			r.observeExclusions(req, plan, state.memberIndex, member, availability)
			if err != nil {
				if errors.Is(err, ErrNoAccount) {
					state.noteAvailability(availability)
					if ctxErr := ctx.Err(); ctxErr != nil {
						return nil, "", Classify(ClassifyInput{Err: ctxErr}), nil
					}
					state.memberIndex++
					continue
				}
				if ctxErr := ctx.Err(); ctxErr != nil {
					return nil, "", Classify(ClassifyInput{Err: ctxErr}), nil
				}
				return nil, "", nil, err
			}
		}
		if err := ctx.Err(); err != nil {
			lease.Release()
			return nil, "", Classify(ClassifyInput{Err: err}), nil
		}
		acct := lease.Account
		prepared := (*PreparedAttempt)(nil)
		preparedReq := currentReq
		if r.preparer != nil {
			var prepareErr error
			prepared, prepareErr = r.preparer.Prepare(ctx, acct, currentReq)
			if prepareErr != nil {
				r.observePreparationExclusion(plan, state.memberIndex, member)
				lease.Release()
				state.markAttempted(state.memberIndex, acct.ID)
				state.noteFailure(Classify(ClassifyInput{Err: errors.Join(ErrCandidatePreparation, prepareErr)}))
				continue
			}
			if prepared == nil {
				r.observePreparationExclusion(plan, state.memberIndex, member)
				lease.Release()
				state.markAttempted(state.memberIndex, acct.ID)
				state.noteFailure(Classify(ClassifyInput{Err: ErrCandidatePreparation}))
				continue
			}
			preparedReq = prepared.Request
			r.pool.MarkReadiness(ReadinessRecord{AccountID: acct.ID, ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, Tier: ReadinessReady, CheckedAt: r.currentTime()})
		}
		nextAttempt := state.attempts + 1
		reservation, reserveErr := r.reserveAttempt(ctx, preparedReq, nextAttempt)
		if reserveErr != nil {
			if prepared != nil {
				_ = prepared.Close()
			}
			lease.Release()
			return nil, "", nil, reserveErr
		}
		state.startAttempt(acct.ID, state.memberIndex)
		startedAt := r.currentTime().UTC()
		attemptCtx, network := withAttemptNetworkEvidence(ctx)
		stream, callErr := callStreamAttempt(attemptCtx, transport, lease, preparedReq)
		endedAt := r.currentTime().UTC()
		evidence := r.attemptEvidence(req, plan, state.memberIndex, member, acct, network.snapshot(), state.attempts, state.repairRule, startedAt, endedAt)
		if callErr == nil {
			if prepared != nil {
				stream.AttachPreparedAttempt(prepared)
			}
			if reservation != nil {
				stream.AttachTokenReservation(ctx, reservation)
			}
			stream.deferTerminalFinish()
			preflightErr := stream.Preflight(ctx)
			evidence.EndedAt = r.currentTime().UTC()
			evidence.LatencyMS = evidence.EndedAt.Sub(evidence.StartedAt).Milliseconds()
			if evidence.LatencyMS < 0 {
				evidence.LatencyMS = 0
			}
			if preflightErr != nil {
				_ = stream.Close()
				state.markAttempted(state.memberIndex, acct.ID)
				if r.currentMemberBudgetRemains(state, state.memberIndex, len(plan.Members)) {
					if repairedBody, repair, accepted := proposeCompatibilityRepair(transport, repairState, acct, currentReq, preflightErr, state.attempts); repair.RuleID != "" {
						r.observeRepair(req, plan, state.memberIndex, state.attempts, repair, accepted)
						if accepted {
							failure := r.classifyFailure(preflightErr, &acct)
							evidence.Result = observability.AttemptFailed
							evidence.Code, evidence.Scope, evidence.Phase = failure.Code, string(failure.Scope), string(failure.Phase)
							evidence.RetryAction = string(RetryRepairSameAccount)
							evidence.RepairRule = repair.RuleID
							r.observeAttempt(evidence)
							state.memberRequests[state.memberIndex].Body = repairedBody
							state.retrySame = &acct
							state.repairRule = repair.RuleID
							continue
						}
					}
				}
				callErr = preflightErr
			} else {
				evidence.Result = observability.AttemptSucceeded
				evidence.Usage = attemptTokenUsage(stream.UsageTokens())
				evidence.Failover = state.failover(acct.ID, state.memberIndex)
				r.observeAttempt(evidence)
				stream.AttachFinalizationEvidence(r.observer, observability.StreamFinalizationEvidence{
					RequestID: evidence.RequestID, CatalogGeneration: evidence.CatalogGeneration,
					Attempt: evidence.Attempt, RouteMember: evidence.RouteMember, Provider: evidence.Provider,
					Model: evidence.Model, AccountID: evidence.AccountID, NetworkMode: evidence.NetworkMode,
					ProxyID: evidence.ProxyID, Surface: evidence.Surface, StartedAt: time.Now().UTC(),
				})
				return stream, acct.ID, nil, nil
			}
		}
		state.markAttempted(state.memberIndex, acct.ID)
		failure := r.classifyFailure(callErr, &acct)
		if stream == nil {
			r.releaseProvenUnaccepted(ctx, reservation, failure)
		}
		state.noteFailure(failure)
		r.applyFailureForModel(failure, &acct, member.UpstreamModelID)
		decision := r.decision(failure, state.refreshAllowed(acct.ID, r.maxRefresh), r.retryBudgetRemains(state, len(plan.Members)))
		state.repairRule = ""
		evidence.Result = observability.AttemptFailed
		evidence.Code, evidence.Scope, evidence.Phase = failure.Code, string(failure.Scope), string(failure.Phase)
		evidence.RetryAction = string(decision.Action)
		evidence.RetryAfterMS = decision.RetryAfter.Milliseconds()
		r.observeAttempt(evidence)
		if !failure.Retryable || !failure.AlternateAccountEligible {
			return nil, "", failure, nil
		}
		if decision.Action == RetryRefreshSameAccount {
			state.markRefresh(acct.ID)
			if err := r.tryRefresh(ctx, acct.ID); err == nil {
				r.pool.Reset(acct.ID)
				_ = r.pool.Refresh(ctx, member.ProviderID)
				// A same-account refresh retry spends the current member's
				// budget; skip it when that member is already exhausted so
				// the loop advances to the next member instead.
				if r.currentMemberBudgetRemains(state, state.memberIndex, len(plan.Members)) {
					state.retrySame = &acct
					continue
				}
			} else {
				refreshFailure := r.classifyFailure(err, &acct)
				state.noteFailure(refreshFailure)
				r.applyFailureForModel(refreshFailure, &acct, member.UpstreamModelID)
				decision = r.decision(refreshFailure, false, r.retryBudgetRemains(state, len(plan.Members)))
			}
		}
		if !r.overallBudgetRemains(state, len(plan.Members)) {
			break
		}
		if decision.Action == RetryStop || !decision.AlternateAccount {
			return nil, "", state.bestFailure, nil
		}
	}
	r.applyAvailabilityHint(state.bestFailure, state.availability)
	if state.bestFailure == nil {
		return nil, "", nil, ErrNoAccount
	}
	return nil, "", state.bestFailure, nil
}

var ErrNilAttemptResponse = errors.New("proxy: transport returned nil response without error")

type hedgeCandidate struct {
	lease       *AccountLease
	prepared    *PreparedAttempt
	req         contracts.Request
	account     Account
	member      catalog.RouteMember
	memberIndex int
	reservation tokenbudget.TokenReservation
	attempt     int
}

type hedgeResult struct {
	candidate *hedgeCandidate
	resp      *contracts.Response
	err       error
	startedAt time.Time
	endedAt   time.Time
	network   attemptNetworkSnapshot
}

// hedgeEligible is intentionally conservative. The Router has no semantic
// commit point for a non-stream response beyond a returned response, so this
// gate only permits requests whose body and route metadata cannot carry
// non-idempotent state.
func (r *Router) hedgeEligible(req contracts.Request, plan catalog.RoutePlan) bool {
	if r == nil || !r.hedgeEnabled || r.maxHedges < 1 || req.Stream || req.ContinuationScope != "" {
		return false
	}
	if plan.Operation != 0 && plan.Operation != catalog.OperationGenerate {
		return false
	}
	for _, feature := range append(append([]catalog.FeatureRequirement(nil), plan.Requirements.Hard...), plan.Requirements.Soft...) {
		switch feature {
		case catalog.FeatureToolDeclaration, catalog.FeatureToolCall, catalog.FeatureToolResult,
			catalog.FeatureNativeTool, catalog.FeatureContinuation, catalog.FeatureCompactionV1, catalog.FeatureCompactionV2:
			return false
		}
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(req.Body, &fields) != nil {
		return false
	}
	var body any
	if json.Unmarshal(req.Body, &body) != nil || hedgeBodyDisqualifies(body) {
		return false
	}
	for _, key := range []string{"tools", "functions", "actions", "native_actions", "computer_use", "server_tools", "mcp_servers"} {
		if raw, ok := fields[key]; ok && hedgeJSONValuePresent(raw) {
			return false
		}
	}
	for _, key := range []string{"tool_choice", "function_call"} {
		if raw, ok := fields[key]; ok && hedgeJSONValuePresent(raw) {
			var value string
			if json.Unmarshal(raw, &value) != nil || value != "none" {
				return false
			}
		}
	}
	for _, key := range []string{"previous_response_id", "continuation", "continuation_id", "semantic_commit", "committed"} {
		if raw, ok := fields[key]; ok && hedgeJSONValuePresent(raw) {
			return false
		}
	}
	return len(plan.Members) > 1
}

func hedgeBodyDisqualifies(value any) bool {
	switch value := value.(type) {
	case []any:
		for _, item := range value {
			if hedgeBodyDisqualifies(item) {
				return true
			}
		}
	case map[string]any:
		for key, item := range value {
			switch key {
			case "tools", "functions", "actions", "native_actions", "computer_use", "server_tools", "mcp_servers":
				if hedgeAnyPresent(item) {
					return true
				}
			case "tool_choice", "function_call":
				if s, ok := item.(string); !ok || s != "none" {
					return true
				}
			case "previous_response_id", "continuation", "continuation_id", "semantic_commit", "committed":
				if hedgeAnyPresent(item) {
					return true
				}
			case "store", "background", "async":
				if b, ok := item.(bool); ok && b {
					return true
				}
			case "type":
				if s, ok := item.(string); ok {
					switch s {
					case "tool_use", "tool_result", "function_call", "function_call_output", "computer_call", "computer_call_output", "server_tool_use", "mcp_call":
						return true
					}
				}
			}
			if hedgeBodyDisqualifies(item) {
				return true
			}
		}
	}
	return false
}

func hedgeAnyPresent(value any) bool {
	if value == nil {
		return false
	}
	switch value := value.(type) {
	case string:
		return value != "" && value != "none"
	case []any:
		return len(value) > 0
	case map[string]any:
		return len(value) > 0
	case bool:
		return value
	default:
		return true
	}
}

func hedgeJSONValuePresent(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return false
	}
	switch value := value.(type) {
	case string:
		return value != "" && value != "none"
	case []any:
		return len(value) > 0
	case map[string]any:
		return len(value) > 0
	case bool:
		return value
	default:
		return true
	}
}

func (r *Router) startHedgeCall(ctx context.Context, transport Transport, candidate *hedgeCandidate) (<-chan hedgeResult, context.CancelFunc) {
	attemptCtx, cancel := context.WithCancel(ctx)
	result := make(chan hedgeResult, 1)
	go func() {
		startedAt := r.currentTime().UTC()
		attemptCtx, network := withAttemptNetworkEvidence(attemptCtx)
		resp, err := callAttempt(attemptCtx, transport, candidate.lease, candidate.req)
		if candidate.prepared != nil {
			_ = candidate.prepared.Close()
		}
		if err == nil && resp == nil {
			err = ErrNilAttemptResponse
		}
		result <- hedgeResult{candidate: candidate, resp: resp, err: err, startedAt: startedAt, endedAt: r.currentTime().UTC(), network: network.snapshot()}
	}()
	return result, cancel
}

func (r *Router) prepareHedgeAlternate(ctx context.Context, first *hedgeCandidate, attempted []map[string]struct{}, memberRequests []contracts.Request, plan catalog.RoutePlan) *hedgeCandidate {
	nextAttempt := first.attempt + 1
	if nextAttempt > r.routeAttemptCap(len(plan.Members)) {
		return nil
	}
	for memberIndex := first.memberIndex; memberIndex < len(plan.Members); memberIndex++ {
		member := plan.Members[memberIndex]
		excluded := make(map[string]struct{}, len(attempted[memberIndex])+1)
		for id := range attempted[memberIndex] {
			excluded[id] = struct{}{}
		}
		if memberIndex == first.memberIndex {
			excluded[first.account.ID] = struct{}{}
		}
		lease, _, err := r.pool.AcquireCandidate(ctx, SelectionInput{ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, ExcludedAccountIDs: excluded})
		if err != nil {
			continue
		}
		acct := lease.Account
		request := memberRequests[memberIndex]
		prepared := (*PreparedAttempt)(nil)
		if r.preparer != nil {
			prepared, err = r.preparer.Prepare(ctx, acct, request)
			if err != nil || prepared == nil {
				lease.Release()
				return nil
			}
			request = prepared.Request
			r.pool.MarkReadiness(ReadinessRecord{AccountID: acct.ID, ProviderID: member.ProviderID, ModelID: member.UpstreamModelID, Surface: member.Surface, PolicyGeneration: plan.PolicyGeneration, Tier: ReadinessReady, CheckedAt: r.currentTime()})
		}
		reservation, reserveErr := r.reserveAttempt(ctx, request, nextAttempt)
		if reserveErr != nil {
			if prepared != nil {
				_ = prepared.Close()
			}
			lease.Release()
			return nil
		}
		return &hedgeCandidate{lease: lease, prepared: prepared, req: request, account: acct, member: member, memberIndex: memberIndex, reservation: reservation, attempt: nextAttempt}
	}
	return nil
}

func (r *Router) discardHedgeCandidate(ctx context.Context, candidate *hedgeCandidate) {
	if candidate == nil {
		return
	}
	if candidate.prepared != nil {
		_ = candidate.prepared.Close()
	}
	if candidate.reservation != nil {
		if err := candidate.reservation.Release(ctx, tokenbudget.ReleaseUnaccepted); err != nil {
			r.quotaPersistenceFailures.Add(1)
		}
	}
	if candidate.lease != nil {
		candidate.lease.Release()
	}
}

func (r *Router) finalizeHedgeLoser(ctx context.Context, result hedgeResult) {
	if result.candidate == nil || result.candidate.reservation == nil {
		return
	}
	if result.err == nil && result.resp != nil {
		if err := result.candidate.reservation.Reconcile(ctx, parseAttemptUsage(result.resp)); err != nil {
			r.quotaPersistenceFailures.Add(1)
		}
		return
	}
	failure := r.classifyFailure(result.err, &result.candidate.account)
	if failure.Phase == FailurePhasePreDispatch {
		r.releaseProvenUnaccepted(ctx, result.candidate.reservation, failure)
		return
	}
	if err := result.candidate.reservation.Reconcile(ctx, usage.Tokens{}); err != nil {
		r.quotaPersistenceFailures.Add(1)
	}
}

func (r *Router) observeHedgeLoser(req contracts.Request, plan catalog.RoutePlan, result hedgeResult) {
	if result.candidate == nil {
		return
	}
	evidence := r.attemptEvidence(req, plan, result.candidate.memberIndex, result.candidate.member, result.candidate.account, result.network, result.candidate.attempt, "", result.startedAt, result.endedAt)
	evidence.Result = observability.AttemptFailed
	evidence.Code = "hedge_loser_canceled"
	evidence.Failover = true
	if result.err != nil {
		failure := r.classifyFailure(result.err, &result.candidate.account)
		evidence.Code, evidence.Scope, evidence.Phase = failure.Code, string(failure.Scope), string(failure.Phase)
	} else if result.resp != nil {
		evidence.Usage = attemptTokenUsage(parseAttemptUsage(result.resp))
	}
	r.observeAttempt(evidence)
}

func (r *Router) executeHedge(ctx context.Context, transport Transport, req contracts.Request, first *hedgeCandidate, state *attemptState, memberRequests []contracts.Request, plan catalog.RoutePlan) (hedgeResult, bool) {
	firstCh, firstCancel := r.startHedgeCall(ctx, transport, first)
	firstResult := func() hedgeResult { return <-firstCh }
	if !r.wait(ctx, r.hedgeDelay) {
		result := firstResult()
		firstCancel()
		return result, false
	}
	select {
	case result := <-firstCh:
		firstCancel()
		return result, false
	default:
	}
	second := r.prepareHedgeAlternate(ctx, first, state.attempted, memberRequests, plan)
	if second == nil {
		result := firstResult()
		firstCancel()
		return result, false
	}
	select {
	case result := <-firstCh:
		r.discardHedgeCandidate(ctx, second)
		firstCancel()
		return result, false
	default:
	}
	secondCh, secondCancel := r.startHedgeCall(ctx, transport, second)
	attempted := state.attempted
	attempted[first.memberIndex][first.account.ID] = struct{}{}
	attempted[second.memberIndex][second.account.ID] = struct{}{}
	// The alternate attempt consumes its member's per-member budget whichever
	// candidate wins; the winner's own attempt was already counted by
	// startAttempt.
	state.noteMemberAttempt(second.memberIndex)
	var firstResultValue, secondResultValue *hedgeResult
	for firstResultValue == nil || secondResultValue == nil {
		select {
		case result := <-firstCh:
			firstResultValue = &result
			if result.err == nil && result.resp != nil {
				secondCancel()
				loser := <-secondCh
				r.finalizeHedgeLoser(ctx, loser)
				r.observeHedgeLoser(req, plan, loser)
				return result, true
			}
		case result := <-secondCh:
			secondResultValue = &result
			if result.err == nil && result.resp != nil {
				firstCancel()
				loser := <-firstCh
				r.finalizeHedgeLoser(ctx, loser)
				r.observeHedgeLoser(req, plan, loser)
				return result, true
			}
		}
	}
	firstCancel()
	secondCancel()
	if firstResultValue != nil {
		if secondResultValue != nil {
			r.finalizeHedgeLoser(ctx, *secondResultValue)
			r.observeHedgeLoser(req, plan, *secondResultValue)
		}
		return *firstResultValue, true
	}
	return *secondResultValue, true
}

// QuotaPersistenceFailures reports bounded post-accept reconciliation failures.
// Client success is not replaced; the durable reservation remains recoverable.
func (r *Router) QuotaPersistenceFailures() uint64 {
	if r == nil {
		return 0
	}
	return r.quotaPersistenceFailures.Load()
}

func (r *Router) reserveAttempt(ctx context.Context, req contracts.Request, attempt int) (tokenbudget.TokenReservation, error) {
	authority, identity, ok := tokenbudget.AuthorityFromContext(ctx)
	if !ok {
		return nil, nil
	}
	estimate, err := estimateAttemptTokens(req, r.defaultOutputCap)
	if err != nil {
		return nil, err
	}
	return authority.Reserve(ctx, tokenbudget.ReservationRequest{
		KeyID: identity.KeyID, RequestID: identity.RequestID, Attempt: attempt,
		WindowUTC: identity.WindowUTC, Estimate: estimate,
	})
}

func (r *Router) releaseProvenUnaccepted(ctx context.Context, reservation tokenbudget.TokenReservation, failure *Failure) {
	if reservation == nil || failure == nil || failure.Phase != FailurePhasePreDispatch {
		return
	}
	if err := reservation.Release(ctx, tokenbudget.ReleaseUnaccepted); err != nil {
		r.quotaPersistenceFailures.Add(1)
	}
}

func estimateAttemptTokens(req contracts.Request, defaultOutputCap int64) (int64, error) {
	outputCap := requestedOutputCap(req.Body)
	if outputCap <= 0 {
		outputCap = defaultOutputCap
	}
	inputEstimate := int64(len(req.Body))
	if inputEstimate > tokenbudget.MaxTokenCount-outputCap {
		return 0, tokenbudget.ErrInvalid
	}
	estimate := inputEstimate + outputCap
	if estimate < 1 || estimate > tokenbudget.MaxTokenCount {
		return 0, tokenbudget.ErrInvalid
	}
	return estimate, nil
}

func requestedOutputCap(body []byte) int64 {
	var request struct {
		MaxOutputTokens     *int64 `json:"max_output_tokens"`
		MaxCompletionTokens *int64 `json:"max_completion_tokens"`
		MaxTokens           *int64 `json:"max_tokens"`
	}
	if json.Unmarshal(body, &request) != nil {
		return 0
	}
	for _, value := range []*int64{request.MaxOutputTokens, request.MaxCompletionTokens, request.MaxTokens} {
		if value != nil && *value > 0 && *value <= tokenbudget.MaxTokenCount {
			return *value
		}
	}
	return 0
}

func parseAttemptUsage(response *contracts.Response) usage.Tokens {
	if response == nil {
		return usage.Tokens{}
	}
	var payload struct {
		Usage struct {
			Input         *int64 `json:"input_tokens"`
			Output        *int64 `json:"output_tokens"`
			Prompt        *int64 `json:"prompt_tokens"`
			Completion    *int64 `json:"completion_tokens"`
			CachedRead    *int64 `json:"cache_read_input_tokens"`
			CachedWrite   *int64 `json:"cache_creation_input_tokens"`
			Reasoning     *int64 `json:"reasoning_tokens"`
			Total         *int64 `json:"total_tokens"`
			PromptDetails struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionDetails struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
			InputDetails struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			OutputDetails struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(response.Body, &payload) != nil {
		return usage.Tokens{}
	}
	input, output := payload.Usage.Input, payload.Usage.Output
	if input == nil {
		input = payload.Usage.Prompt
	}
	if output == nil {
		output = payload.Usage.Completion
	}
	cachedRead := payload.Usage.CachedRead
	if cachedRead == nil {
		cachedRead = payload.Usage.PromptDetails.Cached
	}
	if cachedRead == nil {
		cachedRead = payload.Usage.InputDetails.Cached
	}
	reasoning := payload.Usage.Reasoning
	if reasoning == nil {
		reasoning = payload.Usage.CompletionDetails.Reasoning
	}
	if reasoning == nil {
		reasoning = payload.Usage.OutputDetails.Reasoning
	}
	return usage.Tokens{Input: input, Output: output, CachedRead: cachedRead, CachedWrite: payload.Usage.CachedWrite, Reasoning: reasoning, Total: payload.Usage.Total}
}

func validateRoutePlan(req contracts.Request, plan catalog.RoutePlan) error {
	if len(plan.Members) == 0 || len(plan.Members) > catalog.MaxComboMembers {
		return errors.New("proxy: route plan has an invalid member count")
	}
	if plan.Strategy != catalog.RouteStrategySingle && plan.Strategy != catalog.RouteStrategyFallback {
		return errors.New("proxy: route plan has an unsupported strategy")
	}
	for _, member := range plan.Members {
		if member.ProviderID == "" || member.ClientModelID == "" || member.UpstreamModelID == "" {
			return errors.New("proxy: route plan member is incomplete")
		}
		if member.Surface != req.Protocol {
			return errors.New("proxy: route plan member surface does not match request")
		}
	}
	return nil
}

func prepareMembers(req contracts.Request, plan catalog.RoutePlan) ([]map[string]struct{}, []contracts.Request) {
	attempted := make([]map[string]struct{}, len(plan.Members))
	requests := make([]contracts.Request, len(plan.Members))
	for i, member := range plan.Members {
		attempted[i] = make(map[string]struct{})
		memberReq := req
		if req.Headers != nil {
			memberReq.Headers = req.Headers.Clone()
			memberReq.Headers.Del("X-Cartethyia-Provider")
		}
		memberReq.Model = member.ClientModelID
		memberReq.Protocol = member.Surface
		memberReq.Operation = uint8(plan.Operation)
		requests[i] = memberReq
	}
	return attempted, requests
}

func earlierAvailability(current, candidate Availability) Availability {
	if candidate.RetryAt.IsZero() {
		if current.RetryAt.IsZero() && candidate.SnapshotDegraded {
			current.SnapshotDegraded = true
		}
		return current
	}
	if current.RetryAt.IsZero() || candidate.RetryAt.Before(current.RetryAt) {
		return candidate
	}
	return current
}

func preserveActionableFailure(current, candidate *Failure) *Failure {
	if candidate == nil {
		return current
	}
	if current == nil {
		copyFailure := *candidate
		return &copyFailure
	}
	currentRank := failureActionability(current.Kind)
	candidateRank := failureActionability(candidate.Kind)
	if candidateRank == currentRank {
		copyFailure := *candidate
		return &copyFailure
	}
	earliestRetry := candidate.RetryAfterMS
	if current.RetryAfterMS > 0 && (earliestRetry <= 0 || current.RetryAfterMS < earliestRetry) {
		earliestRetry = current.RetryAfterMS
	}
	selected := current
	if candidateRank > currentRank {
		copyFailure := *candidate
		selected = &copyFailure
	}
	if earliestRetry > 0 {
		selected.RetryAfterMS = earliestRetry
	}
	return selected
}

func failureActionability(kind FailureKind) int {
	switch kind {
	case FailureQuota:
		return 6
	case FailureReauthenticationRequired, FailureAuthentication:
		return 5
	case FailureRateLimit:
		return 4
	case FailureCapacity:
		return 3
	case FailureEmptyOutput, FailureServerError:
		return 2
	case FailureTransient:
		return 1
	default:
		return 0
	}
}

func proposeCompatibilityRepair(transport any, state *RepairState, acct Account, req contracts.Request, failure error, attempt int) ([]byte, RepairEvidence, bool) {
	ruleID, ok := RepairRuleFrom(failure)
	if !ok {
		return nil, RepairEvidence{}, false
	}
	proposer, ok := transport.(CompatibilityRepairTransport)
	if !ok {
		return nil, RepairEvidence{}, false
	}
	proposal, ok := proposer.ProposeRepair(acct, req, ruleID)
	if !ok {
		return nil, RepairEvidence{}, false
	}
	body, evidence, accepted := state.Apply(acct.Provider, attempt, req.Body, proposal)
	return body, evidence, accepted
}

type attemptNetworkContextKey struct{}

type attemptNetworkSnapshot struct {
	mode    string
	proxyID string
}

type attemptNetworkEvidence struct {
	mu      sync.Mutex
	mode    string
	proxyID string
}

func withAttemptNetworkEvidence(ctx context.Context) (context.Context, *attemptNetworkEvidence) {
	evidence := &attemptNetworkEvidence{mode: "unknown"}
	return context.WithValue(ctx, attemptNetworkContextKey{}, evidence), evidence
}

// RecordAttemptNetwork lets the active transport attach only its selected
// network mode and operational proxy ID to the router-owned attempt record.
// Proxy URLs and credentials cannot cross this boundary.
func RecordAttemptNetwork(ctx context.Context, proxied bool, proxyID string) {
	if ctx == nil {
		return
	}
	evidence, _ := ctx.Value(attemptNetworkContextKey{}).(*attemptNetworkEvidence)
	if evidence == nil {
		return
	}
	evidence.mu.Lock()
	if proxied {
		evidence.mode = "proxy"
		evidence.proxyID = proxyID
	} else {
		evidence.mode = "direct"
		evidence.proxyID = ""
	}
	evidence.mu.Unlock()
}

func (e *attemptNetworkEvidence) snapshot() attemptNetworkSnapshot {
	if e == nil {
		return attemptNetworkSnapshot{mode: "unknown"}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return attemptNetworkSnapshot{mode: e.mode, proxyID: e.proxyID}
}

func (r *Router) attemptEvidence(req contracts.Request, plan catalog.RoutePlan, memberIndex int, member catalog.RouteMember, acct Account, network attemptNetworkSnapshot, attempt int, repairRule string, startedAt, endedAt time.Time) observability.AttemptEvidence {
	latency := endedAt.Sub(startedAt).Milliseconds()
	if latency < 0 {
		latency = 0
	}
	surface := string(req.Protocol)
	if req.Stream {
		surface = string(observability.SurfaceStream)
	}
	return observability.AttemptEvidence{
		RequestID: headerValue(req.Headers, "X-Request-ID"), CatalogGeneration: plan.Generation,
		Attempt: attempt, RouteMember: memberIndex, Provider: member.ProviderID,
		Model: member.UpstreamModelID, AccountID: acct.ID, NetworkMode: network.mode,
		ProxyID: network.proxyID, Surface: surface, RepairRule: repairRule,
		StartedAt: startedAt, EndedAt: endedAt, LatencyMS: latency,
	}
}

func (r *Router) observeAttempt(evidence observability.AttemptEvidence) {
	if r == nil || r.observer == nil {
		return
	}
	observeSafely(func() { r.observer.ObserveAttempt(evidence) })
}

func (r *Router) observeExclusions(req contracts.Request, plan catalog.RoutePlan, memberIndex int, member catalog.RouteMember, availability Availability) {
	if r == nil || r.observer == nil {
		return
	}
	now := r.currentTime()
	for _, exclusion := range availability.Exclusions {
		retryAfterMS := int64(0)
		if exclusion.RetryAt.After(now) {
			retryAfterMS = exclusion.RetryAt.Sub(now).Milliseconds()
		}
		evidence := observability.CandidateExclusionEvidence{
			RequestID: headerValue(req.Headers, "X-Request-ID"), CatalogGeneration: plan.Generation,
			RouteMember: memberIndex, Provider: member.ProviderID, Model: member.UpstreamModelID,
			AccountID: exclusion.AccountID, Reason: string(exclusion.Reason), RetryAfterMS: retryAfterMS,
		}
		observeSafely(func() { r.observer.ObserveCandidateExclusion(evidence) })
	}
}

func (r *Router) observePreparationExclusion(plan catalog.RoutePlan, memberIndex int, member catalog.RouteMember) {
	if r == nil || r.observer == nil {
		return
	}
	evidence := observability.CandidateExclusionEvidence{
		CatalogGeneration: plan.Generation, RouteMember: memberIndex,
		Provider: member.ProviderID, Model: member.UpstreamModelID, Reason: "candidate",
	}
	observeSafely(func() { r.observer.ObserveCandidateExclusion(evidence) })
}

func (r *Router) observeRepair(req contracts.Request, plan catalog.RoutePlan, memberIndex, attempt int, repair RepairEvidence, applied bool) {
	if r == nil || r.observer == nil {
		return
	}
	evidence := observability.RepairEvidence{
		RequestID: headerValue(req.Headers, "X-Request-ID"), CatalogGeneration: plan.Generation,
		Attempt: attempt, RouteMember: memberIndex, Provider: repair.Provider,
		Rule: repair.RuleID, Changed: repair.Changed, Applied: applied,
	}
	observeSafely(func() { r.observer.ObserveRepair(evidence) })
}

func (r *Router) observeRequestAttempts(attempts int) {
	if r == nil || r.observer == nil {
		return
	}
	observeSafely(func() { r.observer.ObserveRequestAttempts(attempts) })
}

func (r *Router) observeAccountCooldown() {
	observer, ok := r.observer.(interface{ ObserveAccountCooldown() })
	if !ok {
		return
	}
	observeSafely(observer.ObserveAccountCooldown)
}

func observeSafely(observe func()) {
	defer func() { _ = recover() }()
	observe()
}

func attemptTokenUsage(tokens usage.Tokens) observability.TokenUsage {
	var result observability.TokenUsage
	set := func(mask observability.UsageMask, value *int64, target *int64) {
		if value != nil {
			result.Known |= mask
			*target = *value
		}
	}
	set(observability.UsageInput, tokens.Input, &result.Input)
	set(observability.UsageOutput, tokens.Output, &result.Output)
	set(observability.UsageCachedRead, tokens.CachedRead, &result.CachedRead)
	set(observability.UsageCachedWrite, tokens.CachedWrite, &result.CachedWrite)
	set(observability.UsageReasoning, tokens.Reasoning, &result.Reasoning)
	set(observability.UsageTotal, tokens.Total, &result.Total)
	return result
}

func callAttempt(ctx context.Context, transport Transport, lease *AccountLease, req contracts.Request) (*contracts.Response, error) {
	defer lease.Release()
	return transport.Call(ctx, lease.Account, req)
}

func callStreamAttempt(ctx context.Context, transport StreamTransport, lease *AccountLease, req contracts.Request) (_ *Stream, err error) {
	transferred := false
	defer func() {
		if !transferred {
			lease.Release()
		}
	}()
	stream, err := transport.CallStream(ctx, lease.Account, req)
	if err != nil {
		return nil, err
	}
	if stream == nil {
		return nil, errors.New("proxy: transport returned nil stream without error")
	}
	stream.AttachAccountLease(lease)
	transferred = true
	return stream, nil
}

func (r *Router) classifyFailure(callErr error, acct *Account) *Failure {
	var f *Failure
	var re *contracts.RouteError
	if retryablePrecommitStreamFailure(callErr) {
		f = Classify(ClassifyInput{Kind: FailureTransient, Err: callErr})
		f.Code = StreamCodeOf(callErr)
		f.Message = "provider stream failed before commit"
		f.AlternateAccountEligible = true
	} else if errors.Is(callErr, ErrInvalidEncryptedContent) {
		f = Classify(ClassifyInput{Kind: FailureInvalidRequest, Err: callErr})
	} else if errors.As(callErr, &re) {
		f = FromContracts(re)
	} else {
		f = Classify(ClassifyInput{Err: callErr})
	}
	f.Provider = acct.Provider
	f.Model = acct.Model
	return f
}

func retryablePrecommitStreamFailure(err error) bool {
	switch StreamCodeOf(err) {
	case StreamCodeUpstreamFailure, StreamCodeReadFailure, StreamCodeEventTooLarge,
		StreamCodeMalformedEvent, StreamCodeIdleTimeout, StreamCodeTotalTimeout,
		StreamCodeUpstreamTruncated:
		return true
	default:
		return false
	}
}

// handleFailure remains a compatibility helper for package-local callers.
func (r *Router) handleFailure(callErr error, acct *Account, _ int) *Failure {
	if callErr == nil {
		return nil
	}
	f := r.classifyFailure(callErr, acct)
	r.applyFailure(f, acct)
	return f
}

func (r *Router) applyFailure(f *Failure, acct *Account) {
	r.applyFailureForModel(f, acct, "")
}

func (r *Router) applyFailureForModel(f *Failure, acct *Account, modelID string) {
	if f == nil || acct == nil {
		return
	}
	scope := f.Scope
	if scope == "" {
		scope = f.RateScope
	}
	if scope != contracts.RateScopeAccount && scope != contracts.RateScopeModel {
		return
	}
	accountScoped := scope == contracts.RateScopeAccount
	switch f.Kind {
	case FailureAuthentication, FailureReauthenticationRequired:
		if accountScoped {
			r.pool.MarkAuthentication(acct.ID)
			r.observeAccountCooldown()
		} else {
			r.pool.MarkAuthenticationForModel(acct.ID, modelID)
		}
	case FailureQuota:
		if accountScoped {
			r.pool.MarkExhausted(acct.ID)
			r.observeAccountCooldown()
		} else {
			r.pool.MarkExhaustedForModel(acct.ID, modelID)
		}
	case FailureCapacity, FailureEmptyOutput, FailureTransient, FailureServerError, FailureRateLimit:
		if accountScoped {
			r.pool.MarkTransient(acct.ID)
			r.observeAccountCooldown()
		} else {
			r.pool.MarkTransientForModel(acct.ID, modelID)
		}
	case FailureEntitlement, FailureFatal, FailureUnknown:
		if accountScoped {
			r.pool.MarkError(acct.ID)
			r.observeAccountCooldown()
		} else {
			r.pool.MarkErrorForModel(acct.ID, modelID)
		}
	}
}

func (r *Router) decision(f *Failure, refreshAllowed bool, budgetRemains bool) AttemptDecision {
	if f == nil {
		return AttemptDecision{Action: RetryStop}
	}
	d := AttemptDecision{
		Action: RetryStop, Code: f.Code, Phase: f.Phase, Scope: f.Scope,
		RetryAfter:       time.Duration(f.RetryAfterMS) * time.Millisecond,
		AlternateAccount: f.AlternateAccountEligible,
		RefreshAllowed:   refreshAllowed,
	}
	if !f.Retryable || !budgetRemains {
		return d
	}
	if f.Kind == FailureAuthentication && refreshAllowed && r.refresher != nil {
		d.Action = RetryRefreshSameAccount
		d.AlternateAccount = true
		return d
	}
	if !f.AlternateAccountEligible {
		return d
	}
	if f.Policy == RetryBackoff || d.RetryAfter > 0 {
		d.Action = RetryBackoffNextAccount
	} else {
		d.Action = RetryNextAccount
	}
	return d
}

func (r *Router) waitForAvailability(ctx context.Context, availability Availability) bool {
	if availability.RetryAt.IsZero() || ctx.Err() != nil {
		return false
	}
	delay := availability.RetryAt.Sub(r.currentTime())
	if delay <= 0 {
		return true
	}
	if delay > r.retryWaitMax {
		return false
	}
	if deadline, ok := ctx.Deadline(); ok && !availability.RetryAt.Before(deadline) {
		return false
	}
	return r.wait(ctx, delay)
}

func (r *Router) applyAvailabilityHint(f *Failure, availability Availability) {
	if f == nil || availability.RetryAt.IsZero() {
		return
	}
	delay := availability.RetryAt.Sub(r.currentTime())
	if delay <= 0 {
		return
	}
	retryAfterMS := delay.Milliseconds()
	if retryAfterMS == 0 {
		retryAfterMS = 1
	}
	if f.RetryAfterMS <= 0 || retryAfterMS < f.RetryAfterMS {
		f.RetryAfterMS = retryAfterMS
	}
}

func waitWithTimer(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *Router) tryRefresh(ctx context.Context, accountID string) error {
	if r.refresher == nil {
		return errors.New("proxy: credential refresher is not configured")
	}
	return r.refresher.Refresh(ctx, accountID)
}
