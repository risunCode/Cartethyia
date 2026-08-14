package repositories

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/uptrace/bun"
)

// BunRefreshLeaseStore implements accounts.RefreshLeaseStore over the
// oauth_refresh_leases table. Generation and owner are part of every mutation,
// so a superseded process cannot release a newer lease.
type BunRefreshLeaseStore struct{ db *bun.DB }

func NewBunRefreshLeaseStore(db *bun.DB) *BunRefreshLeaseStore { return &BunRefreshLeaseStore{db: db} }

type refreshLeaseHandle struct {
	store              *BunRefreshLeaseStore
	accountID, ownerID string
	generation         int
	once               chan struct{}
}

func (h *refreshLeaseHandle) Fence() accounts.RefreshFence {
	if h == nil {
		return accounts.RefreshFence{}
	}
	return accounts.RefreshFence{OwnerID: h.ownerID, Generation: int64(h.generation)}
}

func (h *refreshLeaseHandle) Renew(ctx context.Context, ttl time.Duration) error {
	if h == nil || h.store == nil {
		return nil
	}
	ok, err := h.store.Renew(ctx, h.accountID, h.Fence(), ttl)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("refresh lease: ownership lost")
	}
	return nil
}

func (r *BunRefreshLeaseStore) Acquire(ctx context.Context, accountID, ownerID string, ttl time.Duration) (accounts.RefreshLeaseHandle, bool, error) {
	if r == nil || r.db == nil {
		return nil, false, ErrRepositoryClosed
	}
	accountID = strings.TrimSpace(accountID)
	ownerID = strings.TrimSpace(ownerID)
	if accountID == "" || ownerID == "" {
		return nil, false, errors.New("refresh lease: account and owner are required")
	}
	if ttl <= 0 {
		return nil, false, errors.New("refresh lease: ttl must be positive")
	}
	now := time.Now().UTC()
	until := now.Add(ttl).UnixMilli()
	var generation int
	err := r.db.NewRaw(`
INSERT INTO oauth_refresh_leases (account_id, owner_id, generation, token_fingerprint, lease_until_ms, acquired_at_ms)
VALUES (?, ?, 1, '', ?, ?)
ON CONFLICT (account_id) DO UPDATE SET
 owner_id = EXCLUDED.owner_id,
 generation = oauth_refresh_leases.generation + 1,
 token_fingerprint = '',
 lease_until_ms = EXCLUDED.lease_until_ms,
 acquired_at_ms = EXCLUDED.acquired_at_ms
WHERE oauth_refresh_leases.lease_until_ms <= ?
RETURNING generation`, accountID, ownerID, until, now.UnixMilli(), now.UnixMilli()).Scan(ctx, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("refresh lease acquire: %w", err)
	}
	return &refreshLeaseHandle{store: r, accountID: accountID, ownerID: ownerID, generation: generation, once: make(chan struct{}, 1)}, true, nil
}

// Renew extends a live lease only for the exact account, owner, and
// generation that acquired it. Expired or superseded owners cannot revive it.
func (r *BunRefreshLeaseStore) Renew(ctx context.Context, accountID string, fence accounts.RefreshFence, ttl time.Duration) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	accountID = strings.TrimSpace(accountID)
	if accountID == "" || strings.TrimSpace(fence.OwnerID) == "" || fence.Generation <= 0 {
		return false, errors.New("refresh lease: account, owner, and generation are required")
	}
	if ttl <= 0 {
		return false, errors.New("refresh lease: ttl must be positive")
	}
	now := time.Now().UTC()
	until := now.Add(ttl).UnixMilli()
	result, err := r.db.NewRaw(`
UPDATE oauth_refresh_leases
SET lease_until_ms = ?
WHERE account_id = ? AND owner_id = ? AND generation = ? AND lease_until_ms > ?`,
		until, accountID, strings.TrimSpace(fence.OwnerID), fence.Generation, now.UnixMilli()).Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("refresh lease renew: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("refresh lease renew rows: %w", err)
	}
	return count == 1, nil
}

// Release is idempotent. A stale owner/generation is deliberately treated as
// already released rather than being allowed to delete a replacement lease.
func (h *refreshLeaseHandle) Release(ctx context.Context) error {
	if h == nil || h.store == nil {
		return nil
	}
	select {
	case h.once <- struct{}{}:
	default:
		return nil
	}
	_, err := h.store.db.NewRaw(`DELETE FROM oauth_refresh_leases WHERE account_id = ? AND owner_id = ? AND generation = ?`, h.accountID, h.ownerID, h.generation).Exec(ctx)
	return err
}

var _ accounts.RefreshLeaseStore = (*BunRefreshLeaseStore)(nil)
var _ accounts.RefreshLeaseHandle = (*refreshLeaseHandle)(nil)
