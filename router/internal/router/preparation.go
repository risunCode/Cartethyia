package router

import (
	"context"
	"errors"
	"sync"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

var (
	ErrCandidatePreparation  = errors.New("proxy: candidate preparation failed")
	ErrPreparedAttemptClosed = errors.New("proxy: prepared attempt is closed")
)

// CandidatePreparer performs all local work that can fail before a provider
// attempt is counted: credential resolution, body construction, endpoint and
// proxy selection, compatibility generation, and local quota checks.
// Implementations must not make a network call.
type CandidatePreparer interface {
	Prepare(context.Context, Account, contracts.Request) (*PreparedAttempt, error)
}

// PreparedAttempt owns the validated request and every local resource created
// for one candidate. Close is exactly-once and is transferred to Stream when
// a stream attempt succeeds.
type PreparedAttempt struct {
	Account  Account
	Request  contracts.Request
	// Decision is the validated protocol compatibility decision selected for
	// this provider attempt. Its zero value is the explicit canonical default
	// for operations that intentionally do not plan compatibility work.
	Decision contracts.CompatibilityDecision
	closeFn  func() error
	once     sync.Once
	closeErr error
}

// NewPreparedAttemptWithDecision validates and retains the immutable protocol
// decision alongside a prepared provider request. A zero decision is the
// explicit canonical default for preparers that intentionally do not plan.
func NewPreparedAttemptWithDecision(account Account, request contracts.Request, decision contracts.CompatibilityDecision, closeFn func() error) (*PreparedAttempt, error) {
	if account.ID == "" {
		return nil, errors.Join(ErrCandidatePreparation, errors.New("account id is required"))
	}
	if request.Protocol == "" || request.Model == "" {
		return nil, errors.Join(ErrCandidatePreparation, errors.New("prepared request protocol and model are required"))
	}
	if decision.Mode != contracts.ModePass || decision.SourceSurface != "" || decision.TargetSurface != "" ||
		decision.ModelPatch != "" || len(decision.RequiredRepairs) != 0 ||
		len(decision.Unsupported.Features) != 0 || len(decision.Unsupported.Requirements) != 0 ||
		len(decision.Lossy.Features) != 0 || len(decision.Lossy.Requirements) != 0 ||
		decision.CatalogGeneration != 0 || decision.CapabilityVersion != 0 {
		validated, err := contracts.NewCompatibilityDecision(decision)
		if err != nil {
			return nil, errors.Join(ErrCandidatePreparation, err)
		}
		decision = validated
	}
	return &PreparedAttempt{Account: account, Request: request, Decision: decision, closeFn: closeFn}, nil
}

// Close releases local preparation resources exactly once.
func (p *PreparedAttempt) Close() error {
	if p == nil {
		return nil
	}
	p.once.Do(func() {
		if p.closeFn != nil {
			p.closeErr = p.closeFn()
		}
	})
	return p.closeErr
}
