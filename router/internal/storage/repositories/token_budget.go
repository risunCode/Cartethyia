package repositories

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/uptrace/bun"

	"github.com/cartethyia/daemon/internal/telemetry/usage"
	router "github.com/cartethyia/daemon/internal/router"
)

const (
	defaultTokenReservationTTL = 15 * time.Minute
	defaultTokenRecoveryBatch  = 128
	maxTokenRecoveryBatch      = 1024
)

type TokenBudgetOptions struct {
	ReservationTTL   time.Duration
	MaxRecoveryBatch int
}

// BunTokenBudgetRepository is the PostgreSQL token-limit authority. Per-key
// row locks make reserve/reconcile/release atomic across daemon replicas.
type BunTokenBudgetRepository struct {
	db               *bun.DB
	reservationTTL   time.Duration
	maxRecoveryBatch int
}

func NewBunTokenBudgetRepository(db *bun.DB) *BunTokenBudgetRepository {
	return NewBunTokenBudgetRepositoryWithOptions(db, TokenBudgetOptions{})
}

func NewBunTokenBudgetRepositoryWithOptions(db *bun.DB, options TokenBudgetOptions) *BunTokenBudgetRepository {
	if options.ReservationTTL <= 0 {
		options.ReservationTTL = defaultTokenReservationTTL
	}
	if options.MaxRecoveryBatch <= 0 || options.MaxRecoveryBatch > maxTokenRecoveryBatch {
		options.MaxRecoveryBatch = defaultTokenRecoveryBatch
	}
	return &BunTokenBudgetRepository{db: db, reservationTTL: options.ReservationTTL, maxRecoveryBatch: options.MaxRecoveryBatch}
}

type tokenLimitRow struct {
	dailyLimit       *int64
	monthlyLimit     *int64
	oneTimeLimit     *int64
	oneTimeCommitted int64
	oneTimeReserved  int64
}

type tokenReservationRow struct {
	windowAt     time.Time
	dailyStart   time.Time
	monthlyStart time.Time
	estimate     int64
	committed    int64
	status       string
	reason       sql.NullString
	input        sql.NullInt64
	output       sql.NullInt64
	cachedRead   sql.NullInt64
	cachedWrite  sql.NullInt64
	reasoning    sql.NullInt64
	total        sql.NullInt64
	expiresAt    time.Time
}

type durableReservation struct {
	repository *BunTokenBudgetRepository
	keyID      string
	requestID  string
	attempt    int
}

func (r *BunTokenBudgetRepository) Reserve(ctx context.Context, request router.ReservationRequest) (router.TokenReservation, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	if r == nil || r.db == nil {
		return nil, router.ErrUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	windowAt := request.WindowUTC.UTC()
	dailyStart := utcDay(windowAt)
	monthlyStart := utcMonth(windowAt)
	handle := &durableReservation{repository: r, keyID: request.KeyID, requestID: request.RequestID, attempt: request.Attempt}
	err := r.db.RunInTx(ctx, &sql.TxOptions{}, func(ctx context.Context, tx bun.Tx) error {
		limits, err := lockTokenLimits(ctx, tx, request.KeyID, true)
		if err != nil {
			return err
		}
		existing, found, err := lockReservation(ctx, tx, request.KeyID, request.RequestID, request.Attempt)
		if err != nil {
			return err
		}
		if found {
			if existing.estimate != request.Estimate || !sameUTCDay(existing.dailyStart, dailyStart) || !sameUTCDay(existing.monthlyStart, monthlyStart) {
				return router.ErrConflict
			}
			return nil
		}
		if err := ensureWindow(ctx, tx, request.KeyID, "daily", dailyStart); err != nil {
			return err
		}
		if err := ensureWindow(ctx, tx, request.KeyID, "monthly", monthlyStart); err != nil {
			return err
		}
		dailyCommitted, dailyReserved, err := lockWindow(ctx, tx, request.KeyID, "daily", dailyStart)
		if err != nil {
			return err
		}
		monthlyCommitted, monthlyReserved, err := lockWindow(ctx, tx, request.KeyID, "monthly", monthlyStart)
		if err != nil {
			return err
		}
		if exceeds(limits.oneTimeLimit, limits.oneTimeCommitted, limits.oneTimeReserved, request.Estimate) ||
			exceeds(limits.dailyLimit, dailyCommitted, dailyReserved, request.Estimate) ||
			exceeds(limits.monthlyLimit, monthlyCommitted, monthlyReserved, request.Estimate) {
			return router.ErrLimit
		}
		expiresAt := time.Now().UTC().Add(r.reservationTTL)
		if _, err := tx.NewRaw(`INSERT INTO api_key_token_reservations
(key_id, request_id, attempt, window_at, daily_window_start, monthly_window_start, estimate_tokens, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, request.KeyID, request.RequestID, request.Attempt, windowAt, dailyStart, monthlyStart, request.Estimate, expiresAt).Exec(ctx); err != nil {
			return err
		}
		if _, err := tx.NewRaw(`UPDATE api_keys SET one_time_tokens_reserved = one_time_tokens_reserved + ? WHERE id = ?`, request.Estimate, request.KeyID).Exec(ctx); err != nil {
			return err
		}
		if err := addWindowReservation(ctx, tx, request.KeyID, "daily", dailyStart, request.Estimate); err != nil {
			return err
		}
		return addWindowReservation(ctx, tx, request.KeyID, "monthly", monthlyStart, request.Estimate)
	})
	if err != nil {
		return nil, translateTokenBudgetError("reserve", err)
	}
	return handle, nil
}

func (r *durableReservation) Reconcile(ctx context.Context, tokens usage.Tokens) error {
	if r == nil || r.repository == nil || r.repository.db == nil {
		return router.ErrUnavailable
	}
	actual, err := router.AccountedTokens(tokens)
	if err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	err = r.repository.db.RunInTx(ctx, &sql.TxOptions{}, func(ctx context.Context, tx bun.Tx) error {
		if _, err := lockTokenLimits(ctx, tx, r.keyID, false); err != nil {
			return err
		}
		reservation, found, err := lockReservation(ctx, tx, r.keyID, r.requestID, r.attempt)
		if err != nil {
			return err
		}
		if !found {
			return router.ErrConflict
		}
		committedActual := actual
		if !usageComplete(tokens) && committedActual < reservation.estimate {
			committedActual = reservation.estimate
		}
		if reservation.status == "committed" {
			if reservation.committed == committedActual && sameUsage(reservation, tokens) {
				return nil
			}
			return router.ErrConflict
		}
		if reservation.status != "reserved" {
			return router.ErrConflict
		}
		if err := reconcileCounters(ctx, tx, r.keyID, reservation, committedActual); err != nil {
			return err
		}
		_, err = tx.NewRaw(`UPDATE api_key_token_reservations SET
committed_tokens = ?, input_tokens = ?, output_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
status = 'committed', updated_at = NOW()
WHERE key_id = ? AND request_id = ? AND attempt = ? AND status = 'reserved'`,
			committedActual, tokens.Input, tokens.Output, tokens.CachedRead, tokens.CachedWrite, tokens.Reasoning, tokens.Total,
			r.keyID, r.requestID, r.attempt).Exec(ctx)
		return err
	})
	return translateTokenBudgetError("reconcile", err)
}

func (r *durableReservation) Release(ctx context.Context, reason router.ReleaseReason) error {
	if err := reason.Validate(); err != nil {
		return err
	}
	if r == nil || r.repository == nil || r.repository.db == nil {
		return router.ErrUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	released, err := r.repository.release(ctx, r.keyID, r.requestID, r.attempt, reason)
	if err != nil {
		return err
	}
	if !released {
		return nil
	}
	return nil
}

func (r *BunTokenBudgetRepository) release(ctx context.Context, keyID, requestID string, attempt int, reason router.ReleaseReason) (bool, error) {
	released := false
	err := r.db.RunInTx(ctx, &sql.TxOptions{}, func(ctx context.Context, tx bun.Tx) error {
		if _, err := lockTokenLimits(ctx, tx, keyID, false); err != nil {
			return err
		}
		reservation, found, err := lockReservation(ctx, tx, keyID, requestID, attempt)
		if err != nil {
			return err
		}
		if !found {
			return router.ErrConflict
		}
		if reservation.status == "released" {
			if reservation.reason.Valid && reservation.reason.String == string(reason) {
				return nil
			}
			return router.ErrConflict
		}
		if reservation.status != "reserved" {
			return router.ErrConflict
		}
		if err := releaseCounters(ctx, tx, keyID, reservation); err != nil {
			return err
		}
		result, err := tx.NewRaw(`UPDATE api_key_token_reservations SET status = 'released', release_reason = ?, updated_at = NOW() WHERE key_id = ? AND request_id = ? AND attempt = ? AND status = 'reserved'`, string(reason), keyID, requestID, attempt).Exec(ctx)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return err
		}
		released = rows == 1
		return nil
	})
	if err != nil {
		return false, translateTokenBudgetError("release", err)
	}
	return released, nil
}

func (r *BunTokenBudgetRepository) RecoverExpired(ctx context.Context, now time.Time, limit int) (int, error) {
	if r == nil || r.db == nil {
		return 0, router.ErrUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	if limit <= 0 || limit > r.maxRecoveryBatch {
		limit = r.maxRecoveryBatch
	}
	type candidate struct {
		KeyID     string `bun:"key_id"`
		RequestID string `bun:"request_id"`
		Attempt   int    `bun:"attempt"`
	}
	var candidates []candidate
	if err := r.db.NewRaw(`SELECT key_id, request_id, attempt FROM api_key_token_reservations WHERE status = 'reserved' AND expires_at <= ? ORDER BY expires_at, key_id, request_id, attempt LIMIT ?`, now, limit).Scan(ctx, &candidates); err != nil {
		return 0, translateTokenBudgetError("recover", err)
	}
	recovered := 0
	for _, candidate := range candidates {
		ok, err := r.recoverExpiredAttempt(ctx, candidate.KeyID, candidate.RequestID, candidate.Attempt, now)
		if err != nil {
			return recovered, err
		}
		if ok {
			recovered++
		}
	}
	return recovered, nil
}

func (r *BunTokenBudgetRepository) recoverExpiredAttempt(ctx context.Context, keyID, requestID string, attempt int, now time.Time) (bool, error) {
	recovered := false
	err := r.db.RunInTx(ctx, &sql.TxOptions{}, func(ctx context.Context, tx bun.Tx) error {
		if _, err := lockTokenLimits(ctx, tx, keyID, false); err != nil {
			return err
		}
		reservation, found, err := lockReservation(ctx, tx, keyID, requestID, attempt)
		if err != nil {
			return err
		}
		if !found || reservation.status != "reserved" || reservation.expiresAt.After(now) {
			return nil
		}
		// A crash cannot prove the provider rejected the attempt. Commit the
		// estimate as unknown accepted usage rather than silently refunding it.
		if err := reconcileCounters(ctx, tx, keyID, reservation, reservation.estimate); err != nil {
			return err
		}
		result, err := tx.NewRaw(`UPDATE api_key_token_reservations SET committed_tokens = estimate_tokens, status = 'committed', updated_at = NOW() WHERE key_id = ? AND request_id = ? AND attempt = ? AND status = 'reserved'`, keyID, requestID, attempt).Exec(ctx)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return err
		}
		recovered = rows == 1
		return nil
	})
	if err != nil {
		return false, translateTokenBudgetError("recover", err)
	}
	return recovered, nil
}

func lockTokenLimits(ctx context.Context, tx bun.Tx, keyID string, requireActive bool) (tokenLimitRow, error) {
	var row tokenLimitRow
	query := `SELECT daily_token_limit, monthly_token_limit, one_time_token_limit, one_time_tokens_used, one_time_tokens_reserved FROM api_keys WHERE id = ? FOR UPDATE`
	if requireActive {
		query = `SELECT daily_token_limit, monthly_token_limit, one_time_token_limit, one_time_tokens_used, one_time_tokens_reserved FROM api_keys WHERE id = ? AND active = TRUE AND revoked_at IS NULL FOR UPDATE`
	}
	err := tx.NewRaw(query, keyID).Scan(ctx, &row.dailyLimit, &row.monthlyLimit, &row.oneTimeLimit, &row.oneTimeCommitted, &row.oneTimeReserved)
	if errors.Is(err, sql.ErrNoRows) {
		return tokenLimitRow{}, router.ErrUnavailable
	}
	return row, err
}

func lockReservation(ctx context.Context, tx bun.Tx, keyID, requestID string, attempt int) (tokenReservationRow, bool, error) {
	var row tokenReservationRow
	err := tx.NewRaw(`SELECT window_at, daily_window_start, monthly_window_start, estimate_tokens, committed_tokens, status, release_reason,
input_tokens, output_tokens, cached_read_tokens, cached_write_tokens, reasoning_tokens, total_tokens, expires_at
FROM api_key_token_reservations WHERE key_id = ? AND request_id = ? AND attempt = ? FOR UPDATE`, keyID, requestID, attempt).Scan(ctx,
		&row.windowAt, &row.dailyStart, &row.monthlyStart, &row.estimate, &row.committed, &row.status, &row.reason,
		&row.input, &row.output, &row.cachedRead, &row.cachedWrite, &row.reasoning, &row.total, &row.expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return tokenReservationRow{}, false, nil
	}
	return row, err == nil, err
}

func ensureWindow(ctx context.Context, tx bun.Tx, keyID, kind string, start time.Time) error {
	_, err := tx.NewRaw(`INSERT INTO api_key_token_windows (key_id, window_kind, window_start) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, keyID, kind, start).Exec(ctx)
	return err
}

func lockWindow(ctx context.Context, tx bun.Tx, keyID, kind string, start time.Time) (int64, int64, error) {
	var committed, reserved int64
	err := tx.NewRaw(`SELECT committed_tokens, reserved_tokens FROM api_key_token_windows WHERE key_id = ? AND window_kind = ? AND window_start = ? FOR UPDATE`, keyID, kind, start).Scan(ctx, &committed, &reserved)
	return committed, reserved, err
}

func addWindowReservation(ctx context.Context, tx bun.Tx, keyID, kind string, start time.Time, amount int64) error {
	_, err := tx.NewRaw(`UPDATE api_key_token_windows SET reserved_tokens = reserved_tokens + ?, updated_at = NOW() WHERE key_id = ? AND window_kind = ? AND window_start = ?`, amount, keyID, kind, start).Exec(ctx)
	return err
}

func reconcileCounters(ctx context.Context, tx bun.Tx, keyID string, reservation tokenReservationRow, actual int64) error {
	if _, err := tx.NewRaw(`UPDATE api_keys SET one_time_tokens_reserved = one_time_tokens_reserved - ?, one_time_tokens_used = one_time_tokens_used + ? WHERE id = ? AND one_time_tokens_reserved >= ?`, reservation.estimate, actual, keyID, reservation.estimate).Exec(ctx); err != nil {
		return err
	}
	for _, window := range []struct {
		kind  string
		start time.Time
	}{{"daily", reservation.dailyStart}, {"monthly", reservation.monthlyStart}} {
		result, err := tx.NewRaw(`UPDATE api_key_token_windows SET reserved_tokens = reserved_tokens - ?, committed_tokens = committed_tokens + ?, updated_at = NOW() WHERE key_id = ? AND window_kind = ? AND window_start = ? AND reserved_tokens >= ?`, reservation.estimate, actual, keyID, window.kind, window.start, reservation.estimate).Exec(ctx)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != 1 {
			if err != nil {
				return err
			}
			return router.ErrConflict
		}
	}
	return nil
}

func releaseCounters(ctx context.Context, tx bun.Tx, keyID string, reservation tokenReservationRow) error {
	result, err := tx.NewRaw(`UPDATE api_keys SET one_time_tokens_reserved = one_time_tokens_reserved - ? WHERE id = ? AND one_time_tokens_reserved >= ?`, reservation.estimate, keyID, reservation.estimate).Exec(ctx)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		if err != nil {
			return err
		}
		return router.ErrConflict
	}
	for _, window := range []struct {
		kind  string
		start time.Time
	}{{"daily", reservation.dailyStart}, {"monthly", reservation.monthlyStart}} {
		result, err := tx.NewRaw(`UPDATE api_key_token_windows SET reserved_tokens = reserved_tokens - ?, updated_at = NOW() WHERE key_id = ? AND window_kind = ? AND window_start = ? AND reserved_tokens >= ?`, reservation.estimate, keyID, window.kind, window.start, reservation.estimate).Exec(ctx)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != 1 {
			if err != nil {
				return err
			}
			return router.ErrConflict
		}
	}
	return nil
}

func exceeds(limit *int64, committed, reserved, estimate int64) bool {
	if limit == nil {
		return false
	}
	if committed >= *limit || reserved > *limit-committed {
		return true
	}
	return estimate > *limit-committed-reserved
}

func utcDay(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func utcMonth(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func sameUTCDay(a, b time.Time) bool {
	a, b = a.UTC(), b.UTC()
	return a.Year() == b.Year() && a.Month() == b.Month() && a.Day() == b.Day()
}

func sameUsage(row tokenReservationRow, tokens usage.Tokens) bool {
	return sameNullable(row.input, tokens.Input) && sameNullable(row.output, tokens.Output) &&
		sameNullable(row.cachedRead, tokens.CachedRead) && sameNullable(row.cachedWrite, tokens.CachedWrite) &&
		sameNullable(row.reasoning, tokens.Reasoning) && sameNullable(row.total, tokens.Total)
}

func usageComplete(tokens usage.Tokens) bool {
	return tokens.Total != nil || (tokens.Input != nil && tokens.Output != nil)
}

func sameNullable(stored sql.NullInt64, value *int64) bool {
	if value == nil {
		return !stored.Valid
	}
	return stored.Valid && stored.Int64 == *value
}

func translateTokenBudgetError(op string, err error) error {
	if err == nil {
		return nil
	}
	for _, known := range []error{router.ErrInvalid, router.ErrLimit, router.ErrConflict, router.ErrUnavailable} {
		if errors.Is(err, known) {
			return err
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%w: %s persistence failed", router.ErrUnavailable, op)
}

var _ router.TokenBudgetAuthority = (*BunTokenBudgetRepository)(nil)
var _ router.ExpiredReservationRecoverer = (*BunTokenBudgetRepository)(nil)
