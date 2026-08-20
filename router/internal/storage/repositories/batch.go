package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/batch"
	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/uptrace/bun"
)

const (
	maxBatchListLimit = 500
	maxBatchReason    = 1024
)

// BatchRepository owns durable batch lifecycle state. State changes use an
// expected-state compare-and-swap so two workers cannot both claim an item.
// Create persists the job and all of its items in one transaction.
type BatchRepository interface {
	Create(context.Context, batch.Group) (models.BatchJob, error)
	GetJob(context.Context, string) (models.BatchJob, error)
	ListJobs(context.Context, []batch.State, int) ([]models.BatchJob, error)
	GetItems(context.Context, string) ([]models.BatchItem, error)
	TransitionJob(context.Context, string, batch.State, batch.State, *batch.Failure) (bool, error)
	TransitionItem(context.Context, string, batch.ItemState, batch.ItemState, string) (bool, error)
	CancelJob(context.Context, string) (bool, error)
	ExpireJobs(context.Context, time.Time, int) (int, error)
	StoreResult(context.Context, string, batch.Result) (bool, error)
	UpdateItemProgress(context.Context, string, int) (bool, error)
}

type BunBatchRepository struct{ db *bun.DB }

func NewBunBatchRepository(db *bun.DB) *BunBatchRepository {
	return &BunBatchRepository{db: db}
}

var _ BatchRepository = (*BunBatchRepository)(nil)

type batchJobRow struct {
	bun.BaseModel `bun:"table:batch_jobs"`
	ID                 string    `bun:"id"`
	ProviderID         string    `bun:"provider_id"`
	CapabilityVersion  uint64    `bun:"capability_version"`
	Model              string    `bun:"model"`
	Surface            string    `bun:"surface"`
	Endpoint           string    `bun:"endpoint"`
	AccountScope       string    `bun:"account_scope"`
	NetworkID          string    `bun:"network_id"`
	ResponseMode       string    `bun:"response_mode"`
	ToolSchemaDigest   string    `bun:"tool_schema_digest"`
	PolicyDigest       string    `bun:"policy_digest"`
	CatalogGeneration  uint64    `bun:"catalog_generation"`
	TranslationDigest  string    `bun:"translation_digest"`
	State              string    `bun:"state"`
	FailureReason      *string   `bun:"failure_reason"`
	ItemCount          int       `bun:"item_count"`
	Progress           int       `bun:"progress"`
	CreatedAt          time.Time `bun:"created_at"`
	ExpiresAt          time.Time `bun:"expires_at"`
	UpdatedAt          time.Time `bun:"updated_at"`
}

type batchItemRow struct {
	bun.BaseModel `bun:"table:batch_items"`
	ID            string    `bun:"id"`
	JobID         string    `bun:"job_id"`
	Position      int       `bun:"position"`
	RequestID     string    `bun:"request_id"`
	State         string    `bun:"state"`
	Progress      int       `bun:"progress"`
	ResultJSON    []byte    `bun:"result_json,type:jsonb"`
	Error         *string   `bun:"error"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

func (r batchJobRow) model() (models.BatchJob, error) {
	state := batch.State(r.State)
	if !validJobState(state) {
		return models.BatchJob{}, fmt.Errorf("batch: invalid persisted job state %q", r.State)
	}
	var failure *batch.Failure
	if r.FailureReason != nil && strings.TrimSpace(*r.FailureReason) != "" {
		failure = &batch.Failure{Reason: *r.FailureReason}
	}
	return models.BatchJob{
		Job: batch.Job{ID: r.ID, State: state, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, ItemCount: r.ItemCount},
		Key: batch.Key{
			ProviderID: r.ProviderID, CapabilityVersion: r.CapabilityVersion, Model: r.Model,
			Surface: contracts.Surface(r.Surface), Endpoint: r.Endpoint, AccountScope: r.AccountScope,
			NetworkID: r.NetworkID, ResponseMode: r.ResponseMode, ToolSchemaDigest: r.ToolSchemaDigest,
			PolicyDigest: r.PolicyDigest, CatalogGeneration: r.CatalogGeneration, TranslationDigest: r.TranslationDigest,
		},
		Failure: failure, Progress: r.Progress, UpdatedAt: r.UpdatedAt,
	}, nil
}

func (r batchItemRow) model() (models.BatchItem, error) {
	state := batch.ItemState(r.State)
	if !validItemState(state) {
		return models.BatchItem{}, fmt.Errorf("batch: invalid persisted item state %q", r.State)
	}
	item := models.BatchItem{
		Item: batch.Item{ID: r.ID, JobID: r.JobID, Position: r.Position, RequestID: r.RequestID, State: state},
		Progress: r.Progress, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if r.Error != nil {
		item.Error = *r.Error
	}
	if len(r.ResultJSON) != 0 {
		var result batch.Result
		if err := json.Unmarshal(r.ResultJSON, &result); err != nil {
			return models.BatchItem{}, fmt.Errorf("batch: decode item result: %w", err)
		}
		if result.ItemID == "" {
			result.ItemID = r.ID
		}
		if result.State == "" {
			result.State = state
		}
		item.Result = &result
	}
	return item, nil
}

func (r *BunBatchRepository) Create(ctx context.Context, group batch.Group) (models.BatchJob, error) {
	if r == nil || r.db == nil {
		return models.BatchJob{}, ErrRepositoryClosed
	}
	if err := group.Key.Validate(); err != nil {
		return models.BatchJob{}, err
	}
	if strings.TrimSpace(group.Job.ID) == "" {
		return models.BatchJob{}, errors.New("batch: job id is required")
	}
	if len(group.Items) == 0 {
		return models.BatchJob{}, errors.New("batch: item count does not match items")
	}
	if group.Job.ItemCount == 0 {
		group.Job.ItemCount = len(group.Items)
	}
	if group.Job.ItemCount != len(group.Items) {
		return models.BatchJob{}, errors.New("batch: item count does not match items")
	}
	now := time.Now().UTC()
	if group.Job.CreatedAt.IsZero() {
		group.Job.CreatedAt = now
	}
	if group.Job.ExpiresAt.IsZero() {
		return models.BatchJob{}, errors.New("batch: expiry is required")
	}
	if group.Job.State == "" {
		group.Job.State = batch.StateQueued
	}
	if !validJobState(group.Job.State) {
		return models.BatchJob{}, fmt.Errorf("batch: invalid job state %q", group.Job.State)
	}
	row := batchJobRow{
		ID: group.Job.ID, ProviderID: group.Key.ProviderID, CapabilityVersion: group.Key.CapabilityVersion,
		Model: group.Key.Model, Surface: string(group.Key.Surface), Endpoint: group.Key.Endpoint,
		AccountScope: group.Key.AccountScope, NetworkID: group.Key.NetworkID, ResponseMode: group.Key.ResponseMode,
		ToolSchemaDigest: group.Key.ToolSchemaDigest, PolicyDigest: group.Key.PolicyDigest,
		CatalogGeneration: group.Key.CatalogGeneration, TranslationDigest: group.Key.TranslationDigest,
		State: string(group.Job.State), ItemCount: len(group.Items), Progress: 0,
		CreatedAt: group.Job.CreatedAt, ExpiresAt: group.Job.ExpiresAt, UpdatedAt: now,
	}
	itemRows := make([]batchItemRow, len(group.Items))
	seenIDs := make(map[string]struct{}, len(group.Items))
	for i, item := range group.Items {
		if item.ID == "" || item.JobID != group.Job.ID || item.RequestID == "" || item.Position != i {
			return models.BatchJob{}, errors.New("batch: invalid item")
		}
		if _, exists := seenIDs[item.ID]; exists {
			return models.BatchJob{}, errors.New("batch: duplicate item id")
		}
		seenIDs[item.ID] = struct{}{}
		if item.State == "" {
			item.State = batch.ItemQueued
		}
		itemRows[i] = batchItemRow{ID: item.ID, JobID: group.Job.ID, Position: item.Position, RequestID: item.RequestID,
			State: string(item.State), CreatedAt: now, UpdatedAt: now}
		if !validItemState(item.State) {
			return models.BatchJob{}, fmt.Errorf("batch: invalid item state %q", item.State)
		}
	}
	err := r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(&row).Exec(ctx); err != nil {
			return err
		}
		_, err := tx.NewInsert().Model(&itemRows).Exec(ctx)
		return err
	})
	if err != nil {
		return models.BatchJob{}, err
	}
	return row.model()
}

func (r *BunBatchRepository) GetJob(ctx context.Context, id string) (models.BatchJob, error) {
	if r == nil || r.db == nil {
		return models.BatchJob{}, ErrRepositoryClosed
	}
	var row batchJobRow
	if err := r.db.NewSelect().Model(&row).Where("id = ?", strings.TrimSpace(id)).Scan(ctx); err != nil {
		return models.BatchJob{}, err
	}
	return row.model()
}

func (r *BunBatchRepository) ListJobs(ctx context.Context, states []batch.State, limit int) ([]models.BatchJob, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	if limit <= 0 || limit > maxBatchListLimit {
		limit = maxBatchListLimit
	}
	rows := make([]batchJobRow, 0, limit)
	q := r.db.NewSelect().Model(&rows).Order("created_at DESC, id DESC").Limit(limit)
	if len(states) > 0 {
		values := make([]string, len(states))
		for i := range states {
			if !validJobState(states[i]) {
				return nil, fmt.Errorf("batch: invalid job state %q", states[i])
			}
			values[i] = string(states[i])
		}
		q.Where("state IN (?)", bun.In(values))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.BatchJob, len(rows))
	for i := range rows {
		var err error
		out[i], err = rows[i].model()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *BunBatchRepository) GetItems(ctx context.Context, jobID string) ([]models.BatchItem, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []batchItemRow{}
	if err := r.db.NewSelect().Model(&rows).Where("job_id = ?", strings.TrimSpace(jobID)).Order("position ASC").Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.BatchItem, len(rows))
	for i := range rows {
		var err error
		out[i], err = rows[i].model()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *BunBatchRepository) TransitionJob(ctx context.Context, id string, expected, next batch.State, failure *batch.Failure) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	if !validJobState(expected) || !validJobState(next) || !validJobTransition(expected, next) {
		return false, errors.New("batch: invalid job transition state")
	}
	reason := ""
	if failure != nil {
		reason = boundedBatchText(failure.Reason)
	}
	res, err := r.db.NewRaw(`UPDATE batch_jobs SET state = ?, failure_reason = NULLIF(?, ''), updated_at = ? WHERE id = ? AND state = ?`,
		string(next), reason, time.Now().UTC(), strings.TrimSpace(id), string(expected)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (r *BunBatchRepository) TransitionItem(ctx context.Context, id string, expected, next batch.ItemState, message string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	if !validItemState(expected) || !validItemState(next) || !validItemTransition(expected, next) {
		return false, errors.New("batch: invalid item transition state")
	}
	res, err := r.db.NewRaw(`UPDATE batch_items SET state = ?, error = NULLIF(?, ''), progress = CASE WHEN ? IN ('completed','failed','cancelled','expired') THEN 100 ELSE progress END, updated_at = ? WHERE id = ? AND state = ?`,
		string(next), boundedBatchText(message), string(next), time.Now().UTC(), strings.TrimSpace(id), string(expected)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (r *BunBatchRepository) CancelJob(ctx context.Context, id string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	var changed bool
	err := r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewRaw(`UPDATE batch_jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('queued','running')`, time.Now().UTC(), strings.TrimSpace(id)).Exec(ctx)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		changed = n == 1
		if err != nil || !changed {
			return err
		}
		_, err = tx.NewRaw(`UPDATE batch_items SET state = 'cancelled', progress = 100, updated_at = ? WHERE job_id = ? AND state IN ('queued','running')`, time.Now().UTC(), strings.TrimSpace(id)).Exec(ctx)
		return err
	})
	return changed, err
}

func (r *BunBatchRepository) ExpireJobs(ctx context.Context, now time.Time, limit int) (int, error) {
	if r == nil || r.db == nil {
		return 0, ErrRepositoryClosed
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if limit <= 0 || limit > maxBatchListLimit {
		limit = maxBatchListLimit
	}
	var count int
	err := r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		rows := make([]batchJobRow, 0, limit)
		if err := tx.NewSelect().Model(&rows).Column("id").
			Where("expires_at <= ?", now).
			Where("state IN ('queued','running')").
			Order("expires_at ASC, id ASC").Limit(limit).Scan(ctx); err != nil {
			return err
		}
		ids := make([]string, len(rows))
		for i := range rows {
			ids[i] = rows[i].ID
		}
		for _, id := range ids {
			res, err := tx.NewRaw(`UPDATE batch_jobs SET state = 'expired', updated_at = ? WHERE id = ? AND state IN ('queued','running')`, now, id).Exec(ctx)
			if err != nil {
				return err
			}
			affected, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if affected != 1 {
				continue
			}
			if _, err := tx.NewRaw(`UPDATE batch_items SET state = 'expired', progress = 100, updated_at = ? WHERE job_id = ? AND state IN ('queued','running')`, now, id).Exec(ctx); err != nil {
				return err
			}
			count++
		}
		return nil
	})
	return count, err
}

func (r *BunBatchRepository) StoreResult(ctx context.Context, itemID string, result batch.Result) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	if result.ItemID == "" {
		result.ItemID = strings.TrimSpace(itemID)
	}
	if result.ItemID != strings.TrimSpace(itemID) || !validItemState(result.State) {
		return false, errors.New("batch: invalid item result")
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return false, err
	}
	message := boundedBatchText(result.Error)
	changed := false
	err = r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewRaw(`UPDATE batch_items SET state = ?, result_json = ?::jsonb, error = NULLIF(?, ''), progress = CASE WHEN ? IN ('completed','failed','cancelled','expired') THEN 100 ELSE progress END, updated_at = ? WHERE id = ? AND state IN ('queued','running')`,
			string(result.State), raw, message, string(result.State), time.Now().UTC(), strings.TrimSpace(itemID)).Exec(ctx)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		changed = n == 1
		if err != nil || !changed {
			return err
		}
		_, err = tx.NewRaw(`UPDATE batch_jobs j SET progress = COALESCE((SELECT ROUND(AVG(i.progress))::integer FROM batch_items i WHERE i.job_id = j.id), 0), updated_at = ? WHERE j.id = (SELECT job_id FROM batch_items WHERE id = ?)`, time.Now().UTC(), strings.TrimSpace(itemID)).Exec(ctx)
		return err
	})
	return changed, err
}

func (r *BunBatchRepository) UpdateItemProgress(ctx context.Context, itemID string, progress int) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	if progress < 0 || progress > 100 {
		return false, errors.New("batch: progress must be between 0 and 100")
	}
	changed := false
	err := r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewRaw(`UPDATE batch_items SET progress = ?, updated_at = ? WHERE id = ? AND state IN ('queued','running')`, progress, time.Now().UTC(), strings.TrimSpace(itemID)).Exec(ctx)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		changed = n == 1
		if err != nil || !changed {
			return err
		}
		_, err = tx.NewRaw(`UPDATE batch_jobs j SET progress = COALESCE((SELECT ROUND(AVG(i.progress))::integer FROM batch_items i WHERE i.job_id = j.id), 0), updated_at = ? WHERE j.id = (SELECT job_id FROM batch_items WHERE id = ?)`, time.Now().UTC(), strings.TrimSpace(itemID)).Exec(ctx)
		return err
	})
	return changed, err
}

func validJobState(state batch.State) bool {
	switch state {
	case batch.StateQueued, batch.StateRunning, batch.StateCompleted, batch.StateFailed, batch.StateCancelled, batch.StateExpired:
		return true
	default:
		return false
	}
}

func validItemState(state batch.ItemState) bool {
	switch state {
	case batch.ItemQueued, batch.ItemRunning, batch.ItemCompleted, batch.ItemFailed, batch.ItemCancelled, batch.ItemExpired:
		return true
	default:
		return false
	}
}

func validJobTransition(from, to batch.State) bool {
	if from == to {
		return true
	}
	switch from {
	case batch.StateQueued:
		return to == batch.StateRunning || to == batch.StateCancelled || to == batch.StateExpired
	case batch.StateRunning:
		return to == batch.StateCompleted || to == batch.StateFailed || to == batch.StateCancelled || to == batch.StateExpired
	default:
		return false
	}
}

func validItemTransition(from, to batch.ItemState) bool {
	if from == to {
		return true
	}
	switch from {
	case batch.ItemQueued:
		return to == batch.ItemRunning || to == batch.ItemCancelled || to == batch.ItemExpired
	case batch.ItemRunning:
		return to == batch.ItemCompleted || to == batch.ItemFailed || to == batch.ItemCancelled || to == batch.ItemExpired
	default:
		return false
	}
}

func boundedBatchText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > maxBatchReason {
		return value[:maxBatchReason]
	}
	return value
}

