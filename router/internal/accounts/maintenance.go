package accounts

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/accounts/auth"
)

// MaintenanceAccount is the non-secret identity used by background account
// maintenance. ProviderID is used only for grouping and observability; account
// credentials are resolved by the injected Refresher.
type MaintenanceAccount struct {
	ProviderID  string
	AccountID   string
	QuotaResetAt time.Time
}

// AccountMaintenanceConfig bounds one maintenance pass. Workers are shared by
// all providers and accounts in the pass, so a large provider cannot create an
// unbounded goroutine fan-out.
type AccountMaintenanceConfig struct {
	Workers           int
	AccountTimeout    time.Duration
	ReadinessLeaseTTL time.Duration
	Now               func() time.Time
}

const (
	defaultMaintenanceWorkers        = 4
	defaultMaintenanceAccountTimeout = 30 * time.Second
	defaultReadinessLeaseTTL         = 30 * time.Second
)

// AccountMaintenanceHooks are owner-local maintenance operations. Refresh is
// deliberately represented by auth.Refresher: it preserves the refresher's
// per-account single-flight and lease boundaries instead of introducing a
// second credential path. The other operations receive only non-secret account
// identity and must update account-owned state through StateStore.
type AccountMaintenanceHooks struct {
	Refresher  auth.Refresher
	Quota      func(context.Context, MaintenanceAccount) error
	Health     func(context.Context, MaintenanceAccount) error
	Readiness  func(context.Context, MaintenanceAccount) error
}

// MaintenanceState is the narrow account-owned state boundary required by
// maintenance. AccountPool may expose this interface without exporting its
// mutable StateStore implementation.
type MaintenanceState interface {
	Ensure(string, time.Time)
	CheckAndResetDailyQuota(time.Time) int
	AcquireReadinessLease(string, time.Duration) bool
	ReleaseReadinessLease(string)
}

// AccountMaintenanceScheduler runs one bounded, cancellable maintenance pass.
// It is intentionally a pass scheduler rather than a general job system:
// callers provide the current account snapshot and invoke Run on their own
// cadence.
type AccountMaintenanceScheduler struct {
	config  AccountMaintenanceConfig
	state   MaintenanceState
	hooks   AccountMaintenanceHooks
}

func NewAccountMaintenanceScheduler(config AccountMaintenanceConfig, state MaintenanceState, hooks AccountMaintenanceHooks) *AccountMaintenanceScheduler {
	if config.Workers <= 0 {
		config.Workers = defaultMaintenanceWorkers
	}
	if config.AccountTimeout <= 0 {
		config.AccountTimeout = defaultMaintenanceAccountTimeout
	}
	if config.ReadinessLeaseTTL <= 0 {
		config.ReadinessLeaseTTL = defaultReadinessLeaseTTL
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &AccountMaintenanceScheduler{config: config, state: state, hooks: hooks}
}

// Run executes a bounded maintenance pass. Duplicate provider/account pairs
// are coalesced before workers start. The input is copied and sorted so callers
// may safely reuse or mutate their snapshot after Run returns.
func (s *AccountMaintenanceScheduler) Run(ctx context.Context, input []MaintenanceAccount) error {
	if s == nil {
		return errors.New("account maintenance scheduler is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.state != nil {
		s.state.CheckAndResetDailyQuota(s.config.Now())
	}
	items := coalesceMaintenanceAccounts(input)
	if len(items) == 0 {
		return nil
	}

	workers := s.config.Workers
	if workers > len(items) {
		workers = len(items)
	}
	jobs := make(chan MaintenanceAccount)
	var workerWG sync.WaitGroup
	var errMu sync.Mutex
	var firstErr error
	recordErr := func(err error) {
		if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
	}
	worker := func() {
		defer workerWG.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case item, ok := <-jobs:
				if !ok {
					return
				}
				if err := s.maintain(ctx, item); err != nil {
					recordErr(err)
				}
			}
		}
	}
	workerWG.Add(workers)
	for range workers {
		go worker()
	}
	for _, item := range items {
		select {
		case <-ctx.Done():
			close(jobs)
			workerWG.Wait()
			return ctx.Err()
		case jobs <- item:
		}
	}
	close(jobs)
	workerWG.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	errMu.Lock()
	defer errMu.Unlock()
	return firstErr
}

func (s *AccountMaintenanceScheduler) maintain(parent context.Context, item MaintenanceAccount) error {
	if item.AccountID == "" {
		return errors.New("account maintenance account id is empty")
	}
	ctx, cancel := context.WithTimeout(parent, s.config.AccountTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.state != nil {
		s.state.Ensure(item.AccountID, item.QuotaResetAt)
	}
	var firstErr error
	recordErr := func(err error) bool {
		if err == nil {
			return true
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			firstErr = err
			return false
		}
		if firstErr == nil {
			firstErr = err
		}
		return true
	}
	if s.hooks.Refresher != nil {
		token, err := s.hooks.Refresher.Current(ctx, item.AccountID)
		if token != nil {
			token.Close()
		}
		if !recordErr(err) {
			return firstErr
		}
	}
	if s.hooks.Quota != nil {
		if !recordErr(s.hooks.Quota(ctx, item)) {
			return firstErr
		}
	}
	if s.hooks.Health != nil {
		if !recordErr(s.hooks.Health(ctx, item)) {
			return firstErr
		}
	}
	if s.hooks.Readiness == nil {
		return firstErr
	}
	leased := s.state == nil || s.state.AcquireReadinessLease(item.AccountID, s.config.ReadinessLeaseTTL)
	if !leased {
		return firstErr
	}
	if s.state != nil {
		defer s.state.ReleaseReadinessLease(item.AccountID)
	}
	recordErr(s.hooks.Readiness(ctx, item))
	return firstErr
}

func coalesceMaintenanceAccounts(input []MaintenanceAccount) []MaintenanceAccount {
	if len(input) == 0 {
		return nil
	}
	seen := make(map[string]MaintenanceAccount, len(input))
	for _, item := range input {
		if item.AccountID == "" {
			continue
		}
		key := item.ProviderID + "\x00" + item.AccountID
		if previous, ok := seen[key]; ok {
			if previous.QuotaResetAt.IsZero() && !item.QuotaResetAt.IsZero() {
				seen[key] = item
			}
			continue
		}
		seen[key] = item
	}
	items := make([]MaintenanceAccount, 0, len(seen))
	for _, item := range seen {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ProviderID != items[j].ProviderID {
			return items[i].ProviderID < items[j].ProviderID
		}
		return items[i].AccountID < items[j].AccountID
	})
	return items
}
