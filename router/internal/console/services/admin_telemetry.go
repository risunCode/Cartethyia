package services

import (
	. "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
	. "github.com/cartethyia/daemon/internal/console/api"

)

// maxAdminTelemetryLimit mirrors the repository-side telemetry bound so admin
// reads can never ask for a larger page than the SQL layer allows.
const maxAdminTelemetryLimit = 500

// adminTelemetryStore is the narrow bounded read seam consumed by the admin
// telemetry and usage services. *BunTelemetryRepository satisfies it directly.
type adminTelemetryStore interface {
	OverviewStats(ctx context.Context, from, to time.Time, surface string) (models.TelemetryOverview, error)
	TimeBuckets(ctx context.Context, from, to time.Time, granularity, surface string, errorsOnly bool, limit int) ([]models.TelemetryBucketPoint, error)
	UpstreamGroups(ctx context.Context, from, to time.Time, groupBy, surface string, limit int) ([]models.TelemetryUpstreamGroup, error)
	UsageTotals(ctx context.Context, from, to time.Time, surface string) (models.TelemetryUsageTotals, error)
	ClientUsage(ctx context.Context, from, to time.Time, surface string, limit int) ([]models.TelemetryClientUsage, error)
	GetRequest(ctx context.Context, id int64) (models.RequestHistory, error)
}

// postgresTelemetryAdminService implements the admin telemetry contract over
// persisted request_history aggregates. Reads are bounded by the resolved
// window and the repository LIMIT clamp; absent data returns empty payloads.
type postgresTelemetryAdminService struct {
	store adminTelemetryStore
	now   func() time.Time
}

func newPostgresTelemetryAdminService(store adminTelemetryStore) *postgresTelemetryAdminService {
	return &postgresTelemetryAdminService{store: store, now: time.Now}
}

func (s *postgresTelemetryAdminService) Overview(ctx context.Context, input TelemetryQuery) (TelemetryOverview, error) {
	from, to, err := adminTelemetryWindow(input, s.now())
	if err != nil {
		return TelemetryOverview{}, err
	}
	stats, err := s.store.OverviewStats(ctx, from, to, input.Surface)
	if err != nil {
		return TelemetryOverview{}, wrapAdminReadError("telemetry overview", err)
	}
	return TelemetryOverview{Requests: stats.Requests, Errors: stats.Errors, P50: int(stats.P50MS), P95: int(stats.P95MS), P99: int(stats.P99MS), ByRoute: stats.ByRoute}, nil
}

func (s *postgresTelemetryAdminService) Requests(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error) {
	return s.buckets(ctx, input, false)
}

func (s *postgresTelemetryAdminService) Errors(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error) {
	return s.buckets(ctx, input, true)
}

func (s *postgresTelemetryAdminService) buckets(ctx context.Context, input TelemetryQuery, errorsOnly bool) ([]TelemetryBucket, error) {
	from, to, err := adminTelemetryWindow(input, s.now())
	if err != nil {
		return nil, err
	}
	points, err := s.store.TimeBuckets(ctx, from, to, adminTelemetryBucket(input, from, to), input.Surface, errorsOnly, adminTelemetryLimit(input.Limit))
	if err != nil {
		return nil, wrapAdminReadError("telemetry buckets", err)
	}
	out := make([]TelemetryBucket, 0, len(points))
	for _, point := range points {
		out = append(out, TelemetryBucket{Timestamp: point.Timestamp.UTC().Format(time.RFC3339), Count: point.Count, Errors: point.Errors, LatencyMS: int(point.LatencyMS)})
	}
	return out, nil
}

// Upstream returns one bucket per upstream group. Each bucket's Timestamp is
// the window end and Metadata carries the provider (and model when the query
// groups by model); Count, Errors, and LatencyMS are window aggregates.
func (s *postgresTelemetryAdminService) Upstream(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error) {
	from, to, err := adminTelemetryWindow(input, s.now())
	if err != nil {
		return nil, err
	}
	groups, err := s.store.UpstreamGroups(ctx, from, to, input.GroupBy, input.Surface, adminTelemetryLimit(input.Limit))
	if err != nil {
		return nil, wrapAdminReadError("telemetry upstream", err)
	}
	reference := to.UTC().Format(time.RFC3339)
	out := make([]TelemetryBucket, 0, len(groups))
	for _, group := range groups {
		metadata := map[string]any{"provider": group.Provider}
		if input.GroupBy == "model" && group.Model != "" {
			metadata["model"] = group.Model
		}
		out = append(out, TelemetryBucket{Timestamp: reference, Count: group.Count, Errors: group.Errors, LatencyMS: int(group.LatencyMS), Metadata: metadata})
	}
	return out, nil
}

// RequestDetail loads a single persisted request row by id and projects the
// bounded fields into the admin RequestDetail contract. A non-numeric or
// missing row resolves to a 404 so the handler maps cleanly to the operator
// not-found boundary; storage failures keep the existing unavailable contract.
func (s *postgresTelemetryAdminService) RequestDetail(ctx context.Context, id string) (RequestDetail, error) {
	if id == "" {
		return RequestDetail{}, NewError(CodeNotFound, "request not found")
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(id), 10, 64)
	if err != nil || parsed <= 0 {
		return RequestDetail{}, NewError(CodeNotFound, "request not found")
	}
	row, err := s.store.GetRequest(ctx, parsed)
	if err != nil {
		if models.IsNotFound(err) {
			return RequestDetail{}, NewError(CodeNotFound, "request not found")
		}
		return RequestDetail{}, wrapAdminReadError("telemetry request detail", err)
	}
	if row.ID == 0 {
		return RequestDetail{}, NewError(CodeNotFound, "request not found")
	}
	return adminTelemetryRequestDetail(row), nil
}

// adminTelemetryRequestDetail maps the persisted request_history row to the
// bounded admin contract. Only operator-safe fields cross the boundary; raw
// payloads, prompts, credentials, and headers never appear here.
func adminTelemetryRequestDetail(row models.RequestHistory) RequestDetail {
	detail := RequestDetail{
		ID:           strconv.FormatInt(row.ID, 10),
		TraceID:      row.TraceID,
		Model:        row.Model,
		Provider:     row.Provider,
		Surface:      row.Surface,
		Endpoint:     row.Endpoint,
		APIKeyID:     row.APIKeyID,
		APIKeyPrefix: row.APIKeyPrefix,
		Status:       row.Status,
		LatencyMs:    int64(row.DurationMs),
		Error:        row.ErrorKind,
		ClientIP:     row.ClientIP,
		ClientName:   row.ClientName,
		ClientSource: row.ClientSource,
		Stream:       row.Stream,
	}
	if row.InputTokens != nil {
		detail.InputTokens = *row.InputTokens
	}
	if row.OutputTokens != nil {
		detail.OutputTokens = *row.OutputTokens
	}
	if !row.StartedAt.IsZero() {
		detail.StartedAt = row.StartedAt.UTC().Format(time.RFC3339)
	}
	if !row.FinishedAt.IsZero() {
		detail.FinishedAt = row.FinishedAt.UTC().Format(time.RFC3339)
	}
	return detail
}

// postgresUsageAdminService implements the admin usage contract over persisted
// request_history token aggregates.
type postgresUsageAdminService struct {
	store adminTelemetryStore
	now   func() time.Time
}

func newPostgresUsageAdminService(store adminTelemetryStore) *postgresUsageAdminService {
	return &postgresUsageAdminService{store: store, now: time.Now}
}

func (s *postgresUsageAdminService) Usage(ctx context.Context, input TelemetryQuery) (UsageSummary, error) {
	from, to, err := adminTelemetryWindow(input, s.now())
	if err != nil {
		return UsageSummary{}, err
	}
	totals, err := s.store.UsageTotals(ctx, from, to, input.Surface)
	if err != nil {
		return UsageSummary{}, wrapAdminReadError("usage summary", err)
	}
	if totals.Requests <= 0 {
		return UsageSummary{}, nil
	}
	return UsageSummary{
		Requests:     totals.Requests,
		InputTokens:  &totals.InputTokens,
		OutputTokens: &totals.OutputTokens,
		TotalTokens:  &totals.TotalTokens,
		ByProvider:   totals.ByProvider,
		ByModel:      totals.ByModel,
	}, nil
}

func (s *postgresUsageAdminService) Clients(ctx context.Context, input TelemetryQuery) (ClientDistribution, error) {
	from, to, err := adminTelemetryWindow(input, s.now())
	if err != nil {
		return ClientDistribution{}, err
	}
	rows, err := s.store.ClientUsage(ctx, from, to, input.Surface, adminTelemetryLimit(input.Limit))
	if err != nil {
		return ClientDistribution{}, wrapAdminReadError("client distribution", err)
	}
	out := ClientDistribution{Items: make([]ClientUsageItem, 0, len(rows))}
	for _, row := range rows {
		out.Total += row.Count
		if row.Client == "" || row.Client == "unknown" {
			out.Unknown += row.Count
		}
	}
	if out.Total == 0 {
		return out, nil
	}
	for _, row := range rows {
		percentage := math.Round(float64(row.Count)/float64(out.Total)*10000) / 100
		out.Items = append(out.Items, ClientUsageItem{Client: row.Client, Count: row.Count, Percentage: percentage, Source: row.Source, Confidence: adminClientConfidence(row)})
	}
	return out, nil
}

// adminClientConfidence reports how directly a client family was observed.
// Source mirrors the persisted client_source classification, never client input.
func adminClientConfidence(row models.TelemetryClientUsage) string {
	switch row.Source {
	case "user_agent", "header":
		return "observed"
	case "proxy", "daemon":
		if row.Client == "" || row.Client == "unknown" {
			return ""
		}
		return "inferred"
	default:
		if row.Client == "" || row.Client == "unknown" {
			return ""
		}
		return "observed"
	}
}

// adminTelemetryLimit clamps an operator-supplied page size to the shared
// telemetry bound. Missing or oversized values collapse to the bound.
func adminTelemetryLimit(v int) int {
	if v <= 0 || v > maxAdminTelemetryLimit {
		return maxAdminTelemetryLimit
	}
	return v
}

// parseAdminTime parses a bounded RFC3339 timestamp. Empty values map to the
// zero time so callers can treat them as "no bound".
func parseAdminTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	value, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, err
	}
	return value.UTC(), nil
}

// adminTelemetryWindow resolves the bounded read window. Explicit RFC3339
// from/to bounds win; otherwise the period shortcut is applied relative to
// now. A missing period defaults to 24h and "all" keeps the earliest bound,
// leaving aggregate result sets bounded only by their group LIMITs.
func adminTelemetryWindow(input TelemetryQuery, now time.Time) (time.Time, time.Time, error) {
	from, fromErr := parseAdminTime(input.From)
	to, toErr := parseAdminTime(input.To)
	if fromErr != nil || toErr != nil {
		return time.Time{}, time.Time{}, NewError(CodeAdminInvalidRequest, "invalid telemetry window: from/to must be RFC3339 timestamps")
	}
	if !from.IsZero() || !to.IsZero() {
		if to.IsZero() {
			to = now
		}
		if !from.IsZero() && from.After(to) {
			// An inverted window is empty, not an error.
			return to, to, nil
		}
		return from, to, nil
	}
	period := input.Period
	if period == "" {
		period = "24h"
	}
	switch period {
	case "1h":
		from = now.Add(-time.Hour)
	case "24h":
		from = now.Add(-24 * time.Hour)
	case "7d":
		from = now.Add(-7 * 24 * time.Hour)
	case "30d":
		from = now.Add(-30 * 24 * time.Hour)
	case "all":
		from = time.Time{}
	default:
		return time.Time{}, time.Time{}, NewError(CodeAdminInvalidRequest, "invalid telemetry period")
	}
	return from, now, nil
}

// adminTelemetryBucket resolves the bucket granularity. Explicit requests are
// honored; "auto" (or unset) picks the finest granularity that keeps the
// bucket count bounded for the resolved window.
func adminTelemetryBucket(input TelemetryQuery, from, to time.Time) string {
	switch input.Bucket {
	case "minute", "hour", "day":
		return input.Bucket
	}
	window := to.Sub(from)
	switch {
	case window <= 2*time.Hour:
		return "minute"
	case window <= 14*24*time.Hour:
		return "hour"
	default:
		return "day"
	}
}

// wrapAdminReadError keeps storage failures from crossing the operator
// boundary as raw driver messages while preserving the cause for logs.
func wrapAdminReadError(scope string, err error) error {
	return NewError(CodeAdminUnavailable, "observability read is unavailable").WithCause(fmt.Errorf("runtime: %s: %w", scope, err))
}

var _ TelemetryService = (*postgresTelemetryAdminService)(nil)
var _ UsageService = (*postgresUsageAdminService)(nil)
