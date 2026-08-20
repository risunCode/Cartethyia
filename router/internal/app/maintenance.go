package app

import (
	"context"
	"errors"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
)

// AccountMaintenanceSource supplies the current non-secret account snapshot.
// Selection remains owned by the router/account store; the maintenance worker
// only consumes this snapshot and never derives candidates from requests.
type AccountMaintenanceSource func(context.Context) ([]accounts.MaintenanceAccount, error)

// NewAccountMaintenanceWorker adapts the account-owned pass scheduler to the
// runtime RecoveryGroup lifecycle. It is optional: callers that do not provide
// a source or scheduler simply omit the worker. Every probe is cancellation
// driven and the scheduler supplies the worker bound for individual accounts.
func NewAccountMaintenanceWorker(name string, scheduler *accounts.AccountMaintenanceScheduler, source AccountMaintenanceSource, interval, probeTimeout time.Duration) RecoveryWorker {
	if name == "" {
		name = "account_maintenance"
	}
	if interval <= 0 {
		interval = time.Minute
	}
	if probeTimeout <= 0 {
		probeTimeout = interval
	}
	return RecoveryWorker{
		Name:         name,
		Interval:     interval,
		ProbeTimeout: probeTimeout,
		Probe: func(ctx context.Context) error {
			if scheduler == nil || source == nil {
				return errors.New("account maintenance scheduler and source are required")
			}
			items, err := source(ctx)
			if err != nil {
				return err
			}
			return scheduler.Run(ctx, items)
		},
	}
}
