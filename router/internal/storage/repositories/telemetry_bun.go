package repositories

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/cartethyia/daemon/internal/telemetry"
	"github.com/uptrace/bun"
)

const (
	maxTelemetryText    = 512
	maxTelemetryMeta    = 64 << 10
	maxTelemetryPayload = 4 << 20
	maxTelemetryLimit   = 500
	maxTelemetryBatch   = maxTelemetryLimit
)

// BunTelemetryRepository persists bounded request metadata and optional
// payload captures. It never captures payloads implicitly; callers must invoke
// UpsertPayload explicitly when payload capture is enabled.
type BunTelemetryRepository struct{ db *bun.DB }

func NewBunTelemetryRepository(db *bun.DB) *BunTelemetryRepository {
	return &BunTelemetryRepository{db: db}
}

// MetadataSinkAdapter maps bounded, payload-free observability metadata to
// request_history. It deliberately has no payload-writing path.
type MetadataSinkAdapter struct{ repo TelemetryRepository }

var _ telemetry.MaintenanceBatchSink = (*MetadataSinkAdapter)(nil)

func NewMetadataSinkAdapter(repo TelemetryRepository) *MetadataSinkAdapter {
	return &MetadataSinkAdapter{repo: repo}
}

// NewBunMetadataSink is the PostgreSQL-backed constructor used by runtime
// composition. The interface keeps the adapter easy to exercise without a
// live database while still writing through TelemetryRepository.
func NewBunMetadataSink(repo *BunTelemetryRepository) *MetadataSinkAdapter {
	return NewMetadataSinkAdapter(repo)
}

func (s *MetadataSinkAdapter) WriteMetadata(ctx context.Context, metadata telemetry.Metadata) error {
	if s == nil || s.repo == nil {
		return ErrRepositoryClosed
	}
	row, err := metadataRequestHistory(metadata)
	if err != nil {
		return err
	}
	_, err = s.repo.InsertRequest(ctx, row)
	return err
}

func (s *MetadataSinkAdapter) WriteMetadataBatch(ctx context.Context, metadata []telemetry.Metadata) error {
	if s == nil || s.repo == nil {
		return ErrRepositoryClosed
	}
	if len(metadata) == 0 {
		return nil
	}
	if len(metadata) > maxTelemetryBatch {
		return fmt.Errorf("telemetry metadata batch exceeds %d rows", maxTelemetryBatch)
	}
	rows := make([]models.RequestHistory, 0, len(metadata))
	for _, item := range metadata {
		row, err := metadataRequestHistory(item)
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	return s.repo.InsertRequestsBatch(ctx, rows)
}

func metadataRequestHistory(metadata telemetry.Metadata) (models.RequestHistory, error) {
	metadata = metadata.Redacted()
	metaJSON, err := json.Marshal(struct {
		Outcome   telemetry.Outcome `json:"outcome"`
		Cancelled bool                  `json:"cancelled,omitempty"`
	}{Outcome: metadata.Outcome, Cancelled: metadata.Cancelled})
	if err != nil {
		return models.RequestHistory{}, fmt.Errorf("telemetry metadata: %w", err)
	}
	surface := strings.TrimSpace(metadata.Surface)
	if surface == "" {
		surface = "unknown"
	}
	started := metadata.StartedAt
	finished := metadata.EndedAt
	if finished.IsZero() {
		finished = started
	}
	duration := metadata.LatencyMS
	if duration < 0 {
		duration = 0
	}
	row := models.RequestHistory{
		TraceID: metadata.RequestID, Endpoint: "daemon.proxy", Surface: surface,
		Provider: metadata.Provider, Model: metadata.Model, Status: metadataStatus(metadata.Outcome),
		ErrorKind: metadataErrorKind(metadata.Outcome), StartedAt: started, FinishedAt: finished,
		DurationMs: boundedInt64(duration), InputTokens: metadataToken(metadata.InputTokens),
		OutputTokens: metadataToken(metadata.OutputTokens), CachedTokens: metadataToken(metadata.CachedTokens),
		CacheWriteTokens: metadataToken(metadata.CacheWriteTokens), UsageSource: "proxy",
		MetaJSON: metaJSON, ClientName: "daemon", ClientSource: "proxy",
		MessageCount: metadata.MessageCount, ToolCount: metadata.ToolCount, ImageCount: metadata.ImageCount,
	}
	return row, nil
}

func metadataStatus(outcome telemetry.Outcome) int {
	switch outcome {
	case telemetry.OutcomeSuccess:
		return 200
	case telemetry.OutcomeInvalidReq:
		return 400
	case telemetry.OutcomeAuthFailed:
		return 401
	case telemetry.OutcomeQuota:
		return 429
	case telemetry.OutcomeCancelled:
		return 499
	default:
		return 502
	}
}

func metadataErrorKind(outcome telemetry.Outcome) string {
	if outcome == telemetry.OutcomeSuccess {
		return ""
	}
	return bounded(string(outcome), maxTelemetryText)
}

func metadataToken(value *int64) *int {
	if value == nil {
		return nil
	}
	maxInt := int64(^uint(0) >> 1)
	if *value <= 0 {
		zero := 0
		return &zero
	}
	if *value > maxInt {
		out := int(maxInt)
		return &out
	}
	out := int(*value)
	return &out
}

func boundedInt64(value int64) int {
	maxInt := int64(^uint(0) >> 1)
	if value > maxInt {
		return int(maxInt)
	}
	return int(value)
}

type requestHistoryRow struct {
	bun.BaseModel    `bun:"table:request_history"`
	ID               int64     `bun:"id,pk,autoincrement"`
	TraceID          string    `bun:"trace_id"`
	Endpoint         string    `bun:"endpoint"`
	Surface          string    `bun:"surface"`
	APIKeyID         *string   `bun:"api_key_id"`
	APIKeyPrefix     *string   `bun:"api_key_prefix"`
	Provider         *string   `bun:"provider"`
	Model            *string   `bun:"model"`
	Status           int       `bun:"status"`
	ErrorKind        *string   `bun:"error_kind"`
	Stream           bool      `bun:"stream"`
	StartedAt        time.Time `bun:"started_at"`
	FinishedAt       time.Time `bun:"finished_at"`
	DurationMs       int       `bun:"duration_ms"`
	InputTokens      *int      `bun:"input_tokens"`
	OutputTokens     *int      `bun:"output_tokens"`
	CachedTokens     *int      `bun:"cached_tokens"`
	CacheWriteTokens *int      `bun:"cache_write_tokens"`
	ReasoningTokens  *int      `bun:"reasoning_tokens"`
	TotalTokens      *int      `bun:"total_tokens"`
	UsageSource      string    `bun:"usage_source"`
	MetaJSON         []byte    `bun:"meta_json,type:jsonb"`
	ClientName       string    `bun:"client_name"`
	ClientSource     string    `bun:"client_source"`
	MessageCount     int       `bun:"message_count"`
	ToolCount        int       `bun:"tool_count"`
	ImageCount       int       `bun:"image_count"`
	TFFTMs           *int      `bun:"tfft_ms"`
	ClientIP         *string   `bun:"client_ip"`
}

func (r requestHistoryRow) model() models.RequestHistory {
	return models.RequestHistory{ID: r.ID, TraceID: r.TraceID, Endpoint: r.Endpoint, Surface: r.Surface,
		APIKeyID: valueString(r.APIKeyID), APIKeyPrefix: valueString(r.APIKeyPrefix), Provider: valueString(r.Provider), Model: valueString(r.Model),
		Status: r.Status, ErrorKind: valueString(r.ErrorKind), Stream: r.Stream, StartedAt: r.StartedAt, FinishedAt: r.FinishedAt,
		DurationMs: r.DurationMs, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens, CachedTokens: r.CachedTokens,
		CacheWriteTokens: r.CacheWriteTokens, ReasoningTokens: r.ReasoningTokens, TotalTokens: r.TotalTokens, UsageSource: r.UsageSource,
		MetaJSON: append([]byte(nil), r.MetaJSON...), ClientName: r.ClientName, ClientSource: r.ClientSource, MessageCount: r.MessageCount,
		ToolCount: r.ToolCount, ImageCount: r.ImageCount, TFFTMs: r.TFFTMs, ClientIP: valueString(r.ClientIP)}
}

func requestHistoryRowFromModel(v models.RequestHistory) (requestHistoryRow, error) {
	v.TraceID = bounded(strings.TrimSpace(v.TraceID), maxTelemetryText)
	v.Endpoint = bounded(strings.TrimSpace(v.Endpoint), maxTelemetryText)
	v.Surface = bounded(strings.TrimSpace(v.Surface), maxTelemetryText)
	v.APIKeyID = bounded(strings.TrimSpace(v.APIKeyID), maxTelemetryText)
	v.APIKeyPrefix = bounded(strings.TrimSpace(v.APIKeyPrefix), maxTelemetryText)
	v.Provider = bounded(strings.TrimSpace(v.Provider), maxTelemetryText)
	v.Model = bounded(strings.TrimSpace(v.Model), maxTelemetryText)
	v.ErrorKind = bounded(strings.TrimSpace(v.ErrorKind), maxTelemetryText)
	v.UsageSource = bounded(strings.TrimSpace(v.UsageSource), maxTelemetryText)
	v.ClientName = bounded(strings.TrimSpace(v.ClientName), maxTelemetryText)
	v.ClientSource = bounded(strings.TrimSpace(v.ClientSource), maxTelemetryText)
	v.ClientIP = bounded(strings.TrimSpace(v.ClientIP), maxTelemetryText)
	if v.TraceID == "" || v.Endpoint == "" || v.Surface == "" {
		return requestHistoryRow{}, errors.New("telemetry: trace_id, endpoint, and surface are required")
	}
	if len(v.MetaJSON) > maxTelemetryMeta {
		return requestHistoryRow{}, fmt.Errorf("telemetry: metadata exceeds %d bytes", maxTelemetryMeta)
	}
	if len(v.MetaJSON) == 0 {
		v.MetaJSON = []byte("{}")
	}
	if v.UsageSource == "" {
		v.UsageSource = "unknown"
	}
	if v.ClientName == "" {
		v.ClientName = "unknown"
	}
	if v.ClientSource == "" {
		v.ClientSource = "unknown"
	}
	if v.StartedAt.IsZero() {
		v.StartedAt = time.Now().UTC()
	}
	if v.FinishedAt.IsZero() {
		v.FinishedAt = v.StartedAt
	}
	return requestHistoryRow{ID: v.ID, TraceID: v.TraceID, Endpoint: v.Endpoint, Surface: v.Surface,
		APIKeyID: nullable(v.APIKeyID), APIKeyPrefix: nullable(v.APIKeyPrefix), Provider: nullable(v.Provider), Model: nullable(v.Model),
		Status: v.Status, ErrorKind: nullable(v.ErrorKind), Stream: v.Stream, StartedAt: v.StartedAt, FinishedAt: v.FinishedAt,
		DurationMs: v.DurationMs, InputTokens: v.InputTokens, OutputTokens: v.OutputTokens, CachedTokens: v.CachedTokens,
		CacheWriteTokens: v.CacheWriteTokens, ReasoningTokens: v.ReasoningTokens, TotalTokens: v.TotalTokens, UsageSource: v.UsageSource,
		MetaJSON: append([]byte(nil), v.MetaJSON...), ClientName: v.ClientName, ClientSource: v.ClientSource, MessageCount: v.MessageCount,
		ToolCount: v.ToolCount, ImageCount: v.ImageCount, TFFTMs: v.TFFTMs, ClientIP: nullable(v.ClientIP)}, nil
}

func (r *BunTelemetryRepository) InsertRequest(ctx context.Context, v models.RequestHistory) (models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return models.RequestHistory{}, ErrRepositoryClosed
	}
	row, err := requestHistoryRowFromModel(v)
	if err != nil {
		return models.RequestHistory{}, err
	}
	if err := r.db.NewInsert().Model(&row).Returning("*").Scan(ctx); err != nil {
		return models.RequestHistory{}, err
	}
	return row.model(), nil
}

func (r *BunTelemetryRepository) InsertRequestsBatch(ctx context.Context, values []models.RequestHistory) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	if len(values) == 0 {
		return nil
	}
	if len(values) > maxTelemetryBatch {
		return fmt.Errorf("telemetry: batch exceeds %d rows", maxTelemetryBatch)
	}
	rows := make([]requestHistoryRow, 0, len(values))
	for _, value := range values {
		row, err := requestHistoryRowFromModel(value)
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	return r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		_, err := tx.NewInsert().Model(&rows).Exec(ctx)
		return err
	})
}

func (r *BunTelemetryRepository) GetRequest(ctx context.Context, id int64) (models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return models.RequestHistory{}, ErrRepositoryClosed
	}
	var row requestHistoryRow
	if err := r.db.NewSelect().Model(&row).Where("id = ?", id).Scan(ctx); err != nil {
		return models.RequestHistory{}, err
	}
	return row.model(), nil
}

func (r *BunTelemetryRepository) GetRequestByTrace(ctx context.Context, traceID string) (models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return models.RequestHistory{}, ErrRepositoryClosed
	}
	var row requestHistoryRow
	if err := r.db.NewSelect().Model(&row).Where("trace_id = ?", bounded(strings.TrimSpace(traceID), maxTelemetryText)).Scan(ctx); err != nil {
		return models.RequestHistory{}, err
	}
	return row.model(), nil
}

func (r *BunTelemetryRepository) ListRequestsByAPIKey(ctx context.Context, apiKeyID string, limit int) ([]models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	limit = telemetryLimit(limit)
	rows := []requestHistoryRow{}
	if err := r.db.NewSelect().Model(&rows).Where("api_key_id = ?", bounded(strings.TrimSpace(apiKeyID), maxTelemetryText)).Order("id DESC").Limit(limit).Scan(ctx); err != nil {
		return nil, err
	}
	return requestModels(rows), nil
}

// ShareUsage returns only bounded totals needed by the public monitor. It
// deliberately does not group by provider, model, or client metadata.
func (r *BunTelemetryRepository) ShareUsage(ctx context.Context, apiKeyID string, now time.Time) (models.ShareUsage, error) {
	if r == nil || r.db == nil {
		return models.ShareUsage{}, ErrRepositoryClosed
	}
	apiKeyID = bounded(strings.TrimSpace(apiKeyID), maxTelemetryText)
	if apiKeyID == "" {
		return models.ShareUsage{}, errors.New("telemetry: api key id is required")
	}
	now = now.UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var row struct {
		TotalRequests   int64 `bun:"total_requests"`
		TotalTokens     int64 `bun:"total_tokens"`
		DailyRequests   int64 `bun:"daily_requests"`
		DailyTokens     int64 `bun:"daily_tokens"`
		MonthlyRequests int64 `bun:"monthly_requests"`
		MonthlyTokens   int64 `bun:"monthly_tokens"`
	}
	const tokenExpr = `CASE WHEN total_tokens IS NOT NULL THEN total_tokens ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) END`
	query := `SELECT COUNT(*) AS total_requests,
		COALESCE(SUM(` + tokenExpr + `), 0) AS total_tokens,
		COUNT(*) FILTER (WHERE started_at >= ?) AS daily_requests,
		COALESCE(SUM(` + tokenExpr + `) FILTER (WHERE started_at >= ?), 0) AS daily_tokens,
		COUNT(*) FILTER (WHERE started_at >= ?) AS monthly_requests,
		COALESCE(SUM(` + tokenExpr + `) FILTER (WHERE started_at >= ?), 0) AS monthly_tokens
		FROM request_history WHERE api_key_id = ?`
	if err := r.db.NewRaw(query, day, day, month, month, apiKeyID).Scan(ctx, &row); err != nil {
		return models.ShareUsage{}, err
	}
	return models.ShareUsage{TotalRequests: row.TotalRequests, TotalTokens: row.TotalTokens,
		DailyRequests: row.DailyRequests, DailyTokens: row.DailyTokens,
		MonthlyRequests: row.MonthlyRequests, MonthlyTokens: row.MonthlyTokens}, nil
}

func (r *BunTelemetryRepository) ListRequestsOlderThan(ctx context.Context, cutoff string, limit int) ([]models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	limit = telemetryLimit(limit)
	rows := []requestHistoryRow{}
	if err := r.db.NewSelect().Model(&rows).Where("started_at < ?", cutoff).Order("id ASC").Limit(limit).Scan(ctx); err != nil {
		return nil, err
	}
	return requestModels(rows), nil
}

func (r *BunTelemetryRepository) DeleteRequestsOlderThan(ctx context.Context, cutoff string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM request_history WHERE started_at < ?`, cutoff).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

type requestPayloadRow struct {
	bun.BaseModel        `bun:"table:request_payloads"`
	RequestID            string    `bun:"request_id,pk"`
	ClientRequest        []byte    `bun:"client_request"`
	ProviderRequest      []byte    `bun:"provider_request"`
	ProviderResponse     []byte    `bun:"provider_response"`
	ClientResponse       []byte    `bun:"client_response"`
	ClientRequestMeta    []byte    `bun:"client_request_meta"`
	ProviderRequestMeta  []byte    `bun:"provider_request_meta"`
	ProviderResponseMeta []byte    `bun:"provider_response_meta"`
	ClientResponseMeta   []byte    `bun:"client_response_meta"`
	CreatedAt            time.Time `bun:"created_at"`
	UpdatedAt            time.Time `bun:"updated_at"`
}

func (r requestPayloadRow) model() models.RequestPayload {
	return models.RequestPayload{RequestID: r.RequestID, ClientRequest: append([]byte(nil), r.ClientRequest...), ProviderRequest: append([]byte(nil), r.ProviderRequest...), ProviderResponse: append([]byte(nil), r.ProviderResponse...), ClientResponse: append([]byte(nil), r.ClientResponse...), ClientRequestMeta: append([]byte(nil), r.ClientRequestMeta...), ProviderRequestMeta: append([]byte(nil), r.ProviderRequestMeta...), ProviderResponseMeta: append([]byte(nil), r.ProviderResponseMeta...), ClientResponseMeta: append([]byte(nil), r.ClientResponseMeta...), CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}
func payloadBytes(v models.RequestPayload) int {
	return len(v.ClientRequest) + len(v.ProviderRequest) + len(v.ProviderResponse) + len(v.ClientResponse) + len(v.ClientRequestMeta) + len(v.ProviderRequestMeta) + len(v.ProviderResponseMeta) + len(v.ClientResponseMeta)
}
func (r *BunTelemetryRepository) UpsertPayload(ctx context.Context, v models.RequestPayload) (models.RequestPayload, error) {
	if r == nil || r.db == nil {
		return models.RequestPayload{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.RequestID) == "" {
		return models.RequestPayload{}, errors.New("telemetry: request_id is required")
	}
	if payloadBytes(v) > maxTelemetryPayload {
		return models.RequestPayload{}, fmt.Errorf("telemetry: payload exceeds %d bytes", maxTelemetryPayload)
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	v.UpdatedAt = now
	row := requestPayloadRow{RequestID: v.RequestID, ClientRequest: append([]byte(nil), v.ClientRequest...), ProviderRequest: append([]byte(nil), v.ProviderRequest...), ProviderResponse: append([]byte(nil), v.ProviderResponse...), ClientResponse: append([]byte(nil), v.ClientResponse...), ClientRequestMeta: append([]byte(nil), v.ClientRequestMeta...), ProviderRequestMeta: append([]byte(nil), v.ProviderRequestMeta...), ProviderResponseMeta: append([]byte(nil), v.ProviderResponseMeta...), ClientResponseMeta: append([]byte(nil), v.ClientResponseMeta...), CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	_, err := r.db.NewRaw(`INSERT INTO request_payloads (request_id,client_request,provider_request,provider_response,client_response,client_request_meta,provider_request_meta,provider_response_meta,client_response_meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (request_id) DO UPDATE SET client_request=EXCLUDED.client_request,provider_request=EXCLUDED.provider_request,provider_response=EXCLUDED.provider_response,client_response=EXCLUDED.client_response,client_request_meta=EXCLUDED.client_request_meta,provider_request_meta=EXCLUDED.provider_request_meta,provider_response_meta=EXCLUDED.provider_response_meta,client_response_meta=EXCLUDED.client_response_meta,updated_at=EXCLUDED.updated_at`, row.RequestID, row.ClientRequest, row.ProviderRequest, row.ProviderResponse, row.ClientResponse, row.ClientRequestMeta, row.ProviderRequestMeta, row.ProviderResponseMeta, row.ClientResponseMeta, row.CreatedAt, row.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.RequestPayload{}, err
	}
	return row.model(), nil
}
func (r *BunTelemetryRepository) GetPayload(ctx context.Context, id string) (models.RequestPayload, error) {
	if r == nil || r.db == nil {
		return models.RequestPayload{}, ErrRepositoryClosed
	}
	var row requestPayloadRow
	if err := r.db.NewSelect().Model(&row).Where("request_id = ?", strings.TrimSpace(id)).Scan(ctx); err != nil {
		return models.RequestPayload{}, err
	}
	return row.model(), nil
}
func (r *BunTelemetryRepository) DeletePayloadsOlderThan(ctx context.Context, cutoff string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM request_payloads WHERE updated_at < ?`, cutoff).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

type consoleLogRow struct {
	bun.BaseModel `bun:"table:console_logs"`
	ID            int64     `bun:"id,pk,autoincrement"`
	TS            time.Time `bun:"ts"`
	Level         string    `bun:"level"`
	Scope         string    `bun:"scope"`
	Message       string    `bun:"msg"`
}

func (r *BunTelemetryRepository) InsertConsoleLog(ctx context.Context, v models.ConsoleLog) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	v.Level = bounded(strings.TrimSpace(v.Level), 64)
	v.Scope = bounded(strings.TrimSpace(v.Scope), maxTelemetryText)
	v.Message = bounded(strings.TrimSpace(v.Message), maxTelemetryText)
	if v.Level == "" || v.Scope == "" || v.Message == "" {
		return errors.New("telemetry: level, scope, and message are required")
	}
	if v.TS.IsZero() {
		v.TS = time.Now().UTC()
	}
	row := consoleLogRow{TS: v.TS, Level: v.Level, Scope: v.Scope, Message: v.Message}
	_, err := r.db.NewInsert().Model(&row).Exec(ctx)
	return err
}
func (r *BunTelemetryRepository) ListConsoleLogs(ctx context.Context, scope string, limit int) ([]models.ConsoleLog, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []consoleLogRow{}
	q := r.db.NewSelect().Model(&rows).Order("ts DESC").Limit(telemetryLimit(limit))
	if scope = strings.TrimSpace(scope); scope != "" {
		q = q.Where("scope = ?", bounded(scope, maxTelemetryText))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ConsoleLog, len(rows))
	for i, v := range rows {
		out[i] = models.ConsoleLog{ID: v.ID, TS: v.TS, Level: v.Level, Scope: v.Scope, Message: v.Message}
	}
	return out, nil
}
func (r *BunTelemetryRepository) DeleteConsoleLogsOlderThan(ctx context.Context, cutoff string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM console_logs WHERE ts < ?`, cutoff).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Admin aggregation reads back the V2 observability endpoints. Every query is
// parameterized, filtered by a bounded started_at window, and capped by a
// LIMIT so no read can return an unbounded result set.
const (
	maxTelemetryRoutes   = 20
	maxTelemetryGroups   = 50
	telemetryTokenExpr   = `CASE WHEN total_tokens IS NOT NULL THEN total_tokens ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) END`
	telemetryErrorExpr   = `COUNT(*) FILTER (WHERE status >= 400)`
	telemetryLatencyExpr = `COALESCE(ROUND(AVG(duration_ms)), 0)::bigint`
)

// telemetryWindowSQL builds the shared bounded WHERE clause for admin reads.
// The upper bound is exclusive; callers always supply both bounds.
func telemetryWindowSQL(from, to time.Time, surface string) (string, []any) {
	conds := []string{"started_at >= ?", "started_at < ?"}
	args := []any{from.UTC(), to.UTC()}
	if surface = strings.TrimSpace(surface); surface != "" {
		conds = append(conds, "surface = ?")
		args = append(args, bounded(surface, maxTelemetryText))
	}
	return strings.Join(conds, " AND "), args
}

func telemetryGroupLimit(v int) int {
	if v <= 0 || v > maxTelemetryGroups {
		return maxTelemetryGroups
	}
	return v
}

// OverviewStats returns the bounded summary row (counts, error count, latency
// percentiles, and the top routes) for a telemetry window.
func (r *BunTelemetryRepository) OverviewStats(ctx context.Context, from, to time.Time, surface string) (models.TelemetryOverview, error) {
	if r == nil || r.db == nil {
		return models.TelemetryOverview{}, ErrRepositoryClosed
	}
	where, args := telemetryWindowSQL(from, to, surface)
	var row struct {
		Requests int64 `bun:"requests"`
		Errors   int64 `bun:"errors"`
		P50MS    int64 `bun:"p50_ms"`
		P95MS    int64 `bun:"p95_ms"`
		P99MS    int64 `bun:"p99_ms"`
	}
	query := `SELECT COUNT(*) AS requests,
		` + telemetryErrorExpr + ` AS errors,
		COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::bigint AS p50_ms,
		COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::bigint AS p95_ms,
		COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::bigint AS p99_ms
		FROM request_history WHERE ` + where
	if err := r.db.NewRaw(query, args...).Scan(ctx, &row); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.TelemetryOverview{}, nil
		}
		return models.TelemetryOverview{}, err
	}
	out := models.TelemetryOverview{Requests: row.Requests, Errors: row.Errors, P50MS: row.P50MS, P95MS: row.P95MS, P99MS: row.P99MS}
	routes := []struct {
		Route string `bun:"route"`
		Count int64  `bun:"count"`
	}{}
	query = `SELECT endpoint AS route, COUNT(*) AS count FROM request_history WHERE ` + where + ` GROUP BY endpoint ORDER BY count DESC LIMIT ?`
	if err := r.db.NewRaw(query, append(args, maxTelemetryRoutes)...).Scan(ctx, &routes); err != nil {
		return models.TelemetryOverview{}, err
	}
	if len(routes) > 0 {
		out.ByRoute = make(map[string]int64, len(routes))
		for _, v := range routes {
			out.ByRoute[v.Route] = v.Count
		}
	}
	return out, nil
}

// TimeBuckets returns bucketed request/error/latency aggregates. granularity
// must be one of minute|hour|day; errorsOnly restricts the window to failed
// requests so the bucket count is the error count.
func (r *BunTelemetryRepository) TimeBuckets(ctx context.Context, from, to time.Time, granularity, surface string, errorsOnly bool, limit int) ([]models.TelemetryBucketPoint, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	switch granularity {
	case "minute", "hour", "day":
	default:
		return nil, fmt.Errorf("telemetry: unsupported bucket granularity %q", granularity)
	}
	where, args := telemetryWindowSQL(from, to, surface)
	if errorsOnly {
		where += " AND status >= 400"
	}
	query := `SELECT date_trunc(?, started_at) AS ts,
		COUNT(*) AS count,
		` + telemetryErrorExpr + ` AS errors,
		` + telemetryLatencyExpr + ` AS latency_ms
		FROM request_history WHERE ` + where + `
		GROUP BY ts ORDER BY ts ASC LIMIT ?`
	queryArgs := append([]any{granularity}, args...)
	queryArgs = append(queryArgs, telemetryLimit(limit))
	rows := []struct {
		TS        time.Time `bun:"ts"`
		Count     int64     `bun:"count"`
		Errors    int64     `bun:"errors"`
		LatencyMS int64     `bun:"latency_ms"`
	}{}
	if err := r.db.NewRaw(query, queryArgs...).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]models.TelemetryBucketPoint, 0, len(rows))
	for _, v := range rows {
		out = append(out, models.TelemetryBucketPoint{Timestamp: v.TS, Count: v.Count, Errors: v.Errors, LatencyMS: v.LatencyMS})
	}
	return out, nil
}

// UpstreamGroups returns per-provider (or per-provider/model when groupBy is
// "model") aggregates ordered by request volume.
func (r *BunTelemetryRepository) UpstreamGroups(ctx context.Context, from, to time.Time, groupBy, surface string, limit int) ([]models.TelemetryUpstreamGroup, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	grouping := `COALESCE(provider, 'unknown') AS provider`
	groupIndex := `GROUP BY 1`
	if groupBy == "model" {
		grouping += `, COALESCE(model, 'unknown') AS model`
		groupIndex = `GROUP BY 1, 2`
	}
	where, args := telemetryWindowSQL(from, to, surface)
	query := `SELECT ` + grouping + `,
		COUNT(*) AS count,
		` + telemetryErrorExpr + ` AS errors,
		` + telemetryLatencyExpr + ` AS latency_ms
		FROM request_history WHERE ` + where + ` ` + groupIndex + ` ORDER BY count DESC LIMIT ?`
	args = append(args, telemetryGroupLimit(limit))
	rows := []struct {
		Provider  string `bun:"provider"`
		Model     string `bun:"model"`
		Count     int64  `bun:"count"`
		Errors    int64  `bun:"errors"`
		LatencyMS int64  `bun:"latency_ms"`
	}{}
	if err := r.db.NewRaw(query, args...).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]models.TelemetryUpstreamGroup, 0, len(rows))
	for _, v := range rows {
		out = append(out, models.TelemetryUpstreamGroup{Provider: v.Provider, Model: v.Model, Count: v.Count, Errors: v.Errors, LatencyMS: v.LatencyMS})
	}
	return out, nil
}

// UsageTotals returns bounded token sums plus by-provider and by-model token
// maps. Map values are total token sums; per-request detail is never exposed.
func (r *BunTelemetryRepository) UsageTotals(ctx context.Context, from, to time.Time, surface string) (models.TelemetryUsageTotals, error) {
	if r == nil || r.db == nil {
		return models.TelemetryUsageTotals{}, ErrRepositoryClosed
	}
	where, args := telemetryWindowSQL(from, to, surface)
	var row struct {
		Requests     int64 `bun:"requests"`
		InputTokens  int64 `bun:"input_tokens"`
		OutputTokens int64 `bun:"output_tokens"`
		TotalTokens  int64 `bun:"total_tokens"`
	}
	query := `SELECT COUNT(*) AS requests,
		COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
		COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
		COALESCE(SUM(` + telemetryTokenExpr + `), 0)::bigint AS total_tokens
		FROM request_history WHERE ` + where
	if err := r.db.NewRaw(query, args...).Scan(ctx, &row); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.TelemetryUsageTotals{}, nil
		}
		return models.TelemetryUsageTotals{}, err
	}
	out := models.TelemetryUsageTotals{Requests: row.Requests, InputTokens: row.InputTokens, OutputTokens: row.OutputTokens, TotalTokens: row.TotalTokens}
	byDimension := func(column string) (map[string]int64, error) {
		rows := []struct {
			Label  string `bun:"label"`
			Tokens int64  `bun:"tokens"`
		}{}
		query := `SELECT COALESCE(` + column + `, 'unknown') AS label, COALESCE(SUM(` + telemetryTokenExpr + `), 0)::bigint AS tokens FROM request_history WHERE ` + where + ` GROUP BY 1 ORDER BY tokens DESC LIMIT ?`
		if err := r.db.NewRaw(query, append(args, maxTelemetryGroups)...).Scan(ctx, &rows); err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, nil
		}
		values := make(map[string]int64, len(rows))
		for _, v := range rows {
			values[v.Label] = v.Tokens
		}
		return values, nil
	}
	byProvider, err := byDimension("provider")
	if err != nil {
		return models.TelemetryUsageTotals{}, err
	}
	out.ByProvider = byProvider
	byModel, err := byDimension("model")
	if err != nil {
		return models.TelemetryUsageTotals{}, err
	}
	out.ByModel = byModel
	return out, nil
}

// ClientUsage returns the client-family distribution for a telemetry window.
// Missing client evidence collapses into the explicit "unknown" family.
func (r *BunTelemetryRepository) ClientUsage(ctx context.Context, from, to time.Time, surface string, limit int) ([]models.TelemetryClientUsage, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	where, args := telemetryWindowSQL(from, to, surface)
	query := `SELECT COALESCE(NULLIF(client_name, ''), 'unknown') AS client,
		COALESCE(NULLIF(client_source, ''), 'unknown') AS source,
		COUNT(*) AS count
		FROM request_history WHERE ` + where + ` GROUP BY 1, 2 ORDER BY count DESC LIMIT ?`
	args = append(args, telemetryGroupLimit(limit))
	rows := []struct {
		Client string `bun:"client"`
		Source string `bun:"source"`
		Count  int64  `bun:"count"`
	}{}
	if err := r.db.NewRaw(query, args...).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]models.TelemetryClientUsage, 0, len(rows))
	for _, v := range rows {
		out = append(out, models.TelemetryClientUsage{Client: v.Client, Source: v.Source, Count: v.Count})
	}
	return out, nil
}

// ListConsoleLogsFiltered returns bounded operator console evidence. From/To
// are inclusive; Level and Scope are exact matches.
func (r *BunTelemetryRepository) ListConsoleLogsFiltered(ctx context.Context, filter models.ConsoleLogFilter) ([]models.ConsoleLog, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []consoleLogRow{}
	q := r.db.NewSelect().Model(&rows).Order("ts DESC").Limit(telemetryLimit(filter.Limit))
	if !filter.From.IsZero() {
		q = q.Where("ts >= ?", filter.From.UTC())
	}
	if !filter.To.IsZero() {
		q = q.Where("ts <= ?", filter.To.UTC())
	}
	if filter.Level = strings.TrimSpace(filter.Level); filter.Level != "" {
		q = q.Where("level = ?", bounded(filter.Level, 64))
	}
	if filter.Scope = strings.TrimSpace(filter.Scope); filter.Scope != "" {
		q = q.Where("scope = ?", bounded(filter.Scope, maxTelemetryText))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ConsoleLog, len(rows))
	for i, v := range rows {
		out[i] = models.ConsoleLog{ID: v.ID, TS: v.TS, Level: v.Level, Scope: v.Scope, Message: v.Message}
	}
	return out, nil
}

func valueString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
func bounded(v string, n int) string {
	if len(v) > n {
		return v[:n]
	}
	return v
}
func telemetryLimit(v int) int {
	if v <= 0 || v > maxTelemetryLimit {
		return maxTelemetryLimit
	}
	return v
}
func requestModels(rows []requestHistoryRow) []models.RequestHistory {
	out := make([]models.RequestHistory, len(rows))
	for i, v := range rows {
		out[i] = v.model()
	}
	return out
}

var _ TelemetryRepository = (*BunTelemetryRepository)(nil)
