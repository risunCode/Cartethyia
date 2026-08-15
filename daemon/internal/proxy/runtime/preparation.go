package proxy

import (
	"context"
	"errors"
	"sync"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
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
	closeFn  func() error
	once     sync.Once
	closeErr error
}

// NewPreparedAttempt validates the local preparation result.
func NewPreparedAttempt(account Account, request contracts.Request, closeFn func() error) (*PreparedAttempt, error) {
	if account.ID == "" {
		return nil, errors.Join(ErrCandidatePreparation, errors.New("account id is required"))
	}
	if request.Protocol == "" || request.Model == "" {
		return nil, errors.Join(ErrCandidatePreparation, errors.New("prepared request protocol and model are required"))
	}
	return &PreparedAttempt{Account: account, Request: request, closeFn: closeFn}, nil
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
