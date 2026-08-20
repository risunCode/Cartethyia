package router

import (
	"context"
	"errors"
	"sync"
	"time"

	authaccounts "github.com/cartethyia/daemon/internal/accounts/auth"
	accounts "github.com/cartethyia/daemon/internal/accounts"
	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// ReadinessTier is deliberately small and explainable. It is not a health
// score and never uses billable model probes.
type ReadinessTier = accounts.ReadinessTier

const (
	ReadinessUnknown = accounts.ReadinessUnknown
	ReadinessStale = accounts.ReadinessStale
	ReadinessReady = accounts.ReadinessReady
	ReadinessUnavailable = accounts.ReadinessUnavailable
)

// ReadinessRecord adapts account-owned readiness evidence to the router's
// protocol Surface type. The authoritative record is accounts.ReadinessRecord;
// AccountPool converts this boundary value before storing it.
type ReadinessRecord struct {
	AccountID        string
	ProviderID       string
	ModelID          string
	Surface          contracts.Surface
	PolicyGeneration uint64
	Tier             ReadinessTier
	Code             string
	CheckedAt        time.Time
	RetryAt          time.Time
}

// CredentialReadinessRefresher exposes the existing non-billable credential
// refresh operation. Current must apply its provider safety skew internally.
type CredentialReadinessRefresher interface {
	Current(context.Context, string) (*authaccounts.TokenSet, error)
}

// ProactiveRefreshWorker is a bounded, cancelable readiness refresh loop.
type ProactiveRefreshWorker struct {
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

// StartProactiveRefresh refreshes only credential state in bounded pages.
// It never probes a model, sends a prompt, or acquires an upstream attempt.
func (p *AccountPool) StartProactiveRefresh(parent context.Context, refresher CredentialReadinessRefresher, providerID string, pageSize int, interval time.Duration) (*ProactiveRefreshWorker, error) {
	if p == nil || refresher == nil || providerID == "" {
		return nil, errors.New("proxy: proactive refresh requires pool, refresher, and provider")
	}
	if parent == nil {
		parent = context.Background()
	}
	if pageSize <= 0 || pageSize > 32 {
		pageSize = 16
	}
	if interval <= 0 {
		interval = time.Minute
	}
	ctx, cancel := context.WithCancel(parent)
	worker := &ProactiveRefreshWorker{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(worker.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			p.refreshReadinessPage(ctx, refresher, providerID, pageSize)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return worker, nil
}

func (p *AccountPool) refreshReadinessPage(ctx context.Context, refresher CredentialReadinessRefresher, providerID string, pageSize int) {
	snapshot, err := p.providerAccounts(ctx, providerID, false)
	if err != nil {
		return
	}
	for start := 0; start < len(snapshot.accounts); start += pageSize {
		end := start + pageSize
		if end > len(snapshot.accounts) {
			end = len(snapshot.accounts)
		}
		for _, account := range snapshot.accounts[start:end] {
			if !p.acquireReadinessRefreshLease(account.ID, time.Minute) {
				continue
			}
			if !account.Enabled || account.ReauthRequired {
				p.MarkReadiness(ReadinessRecord{AccountID: account.ID, ProviderID: providerID, ModelID: account.Model, Tier: ReadinessUnavailable, Code: "credential.reauth_required", CheckedAt: p.now()})
				p.releaseReadinessRefreshLease(account.ID)
				continue
			}
			_, currentErr := refresher.Current(ctx, account.ID)
			record := ReadinessRecord{AccountID: account.ID, ProviderID: providerID, ModelID: account.Model, Tier: ReadinessReady, CheckedAt: p.now()}
			if currentErr != nil {
				record.Tier = ReadinessStale
				record.Code = "credential.refresh_failed"
				record.RetryAt = p.now().Add(time.Minute)
			}
			p.MarkReadiness(record)
			p.releaseReadinessRefreshLease(account.ID)
		}
		if ctx.Err() != nil {
			return
		}
	}
}

func (p *AccountPool) acquireReadinessRefreshLease(accountID string, ttl time.Duration) bool {
	return p.stateOwner.AcquireReadinessLease(accountID, ttl)
}

func (p *AccountPool) releaseReadinessRefreshLease(accountID string) {
	p.stateOwner.ReleaseReadinessLease(accountID)
}

func (w *ProactiveRefreshWorker) Stop() {
	if w == nil {
		return
	}
	w.once.Do(func() {
		if w.cancel != nil {
			w.cancel()
		}
		if w.done != nil {
			<-w.done
		}
	})
}
