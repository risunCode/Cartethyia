package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/cartethyia/daemon/internal/observability"
	"github.com/uptrace/bun"
)

const (
	maxTelemetryText    = 512
	maxTelemetryMeta    = 64 << 10
	maxTelemetryPayload = 4 << 20
	maxTelemetryLimit   = 500
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

func NewMetadataSinkAdapter(repo TelemetryRepository) *MetadataSinkAdapter {
	return &MetadataSinkAdapter{repo: repo}
}

// NewBunMetadataSink is the PostgreSQL-backed constructor used by runtime
// composition. The interface keeps the adapter easy to exercise without a
// live database while still writing through TelemetryRepository.
func NewBunMetadataSink(repo *BunTelemetryRepository) *MetadataSinkAdapter {
	return NewMetadataSinkAdapter(repo)
}

func (s *MetadataSinkAdapter) WriteMetadata(ctx context.Context, metadata observability.Metadata) error {
	if s == nil || s.repo == nil {
		return ErrRepositoryClosed
	}
	metadata = metadata.Redacted()
	metaJSON, err := json.Marshal(struct {
		Outcome   observability.Outcome `json:"outcome"`
		ToolNames []string              `json:"tool_names,omitempty"`
		Cancelled bool                  `json:"cancelled,omitempty"`
	}{Outcome: metadata.Outcome, ToolNames: metadata.ToolNames, Cancelled: metadata.Cancelled})
	if err != nil {
		return fmt.Errorf("telemetry metadata: %w", err)
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
	_, err = s.repo.InsertRequest(ctx, row)
	return err
}

func metadataStatus(outcome observability.Outcome) int {
	switch outcome {
	case observability.OutcomeSuccess:
		return 200
	case observability.OutcomeInvalidReq:
		return 400
	case observability.OutcomeAuthFailed:
		return 401
	case observability.OutcomeQuota:
		return 429
	case observability.OutcomeCancelled:
		return 499
	default:
		return 502
	}
}

func metadataErrorKind(outcome observability.Outcome) string {
	if outcome == observability.OutcomeSuccess {
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
	if err := r.db.NewInsert().Model(&row).Table("request_history").Returning("*").Scan(ctx); err != nil {
		return models.RequestHistory{}, err
	}
	return row.model(), nil
}

func (r *BunTelemetryRepository) GetRequest(ctx context.Context, id int64) (models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return models.RequestHistory{}, ErrRepositoryClosed
	}
	var row requestHistoryRow
	if err := r.db.NewSelect().Model(&row).Table("request_history").Where("id = ?", id).Scan(ctx); err != nil {
		return models.RequestHistory{}, err
	}
	return row.model(), nil
}

func (r *BunTelemetryRepository) GetRequestByTrace(ctx context.Context, traceID string) (models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return models.RequestHistory{}, ErrRepositoryClosed
	}
	var row requestHistoryRow
	if err := r.db.NewSelect().Model(&row).Table("request_history").Where("trace_id = ?", bounded(strings.TrimSpace(traceID), maxTelemetryText)).Scan(ctx); err != nil {
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
	if err := r.db.NewSelect().Model(&rows).Table("request_history").Where("api_key_id = ?", bounded(strings.TrimSpace(apiKeyID), maxTelemetryText)).Order("id DESC").Limit(limit).Scan(ctx); err != nil {
		return nil, err
	}
	return requestModels(rows), nil
}

func (r *BunTelemetryRepository) ListRequestsOlderThan(ctx context.Context, cutoff string, limit int) ([]models.RequestHistory, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	limit = telemetryLimit(limit)
	rows := []requestHistoryRow{}
	if err := r.db.NewSelect().Model(&rows).Table("request_history").Where("started_at < ?", cutoff).Order("id ASC").Limit(limit).Scan(ctx); err != nil {
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
	if err := r.db.NewSelect().Model(&row).Table("request_payloads").Where("request_id = ?", strings.TrimSpace(id)).Scan(ctx); err != nil {
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
	ID      int64     `bun:"id,pk,autoincrement"`
	TS      time.Time `bun:"ts"`
	Level   string    `bun:"level"`
	Scope   string    `bun:"scope"`
	Message string    `bun:"msg"`
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
	_, err := r.db.NewInsert().Model(&row).Table("console_logs").Exec(ctx)
	return err
}
func (r *BunTelemetryRepository) ListConsoleLogs(ctx context.Context, scope string, limit int) ([]models.ConsoleLog, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []consoleLogRow{}
	q := r.db.NewSelect().Model(&rows).Table("console_logs").Order("ts DESC").Limit(telemetryLimit(limit))
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
