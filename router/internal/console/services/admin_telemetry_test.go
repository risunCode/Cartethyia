package services

import (
	. "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"database/sql"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
	. "github.com/cartethyia/daemon/internal/console/api"

)

type fakeTelemetryStore struct {
	overview    models.TelemetryOverview
	overviewErr error
	buckets     []models.TelemetryBucketPoint
	bucketErr   error
	groups      []models.TelemetryUpstreamGroup
	groupErr    error
	usage       models.TelemetryUsageTotals
	usageErr    error
	clients     []models.TelemetryClientUsage
	clientErr   error
	request     models.RequestHistory
	requestErr  error
	requestID   int64

	overviewCalls []fakeTelemetryCall
	bucketCalls   []fakeTelemetryCall
	groupCalls    []fakeTelemetryCall
	usageCalls    []fakeTelemetryCall
	clientCalls   []fakeTelemetryCall
	requestCalls  []int64
}

type fakeTelemetryCall struct {
	from      time.Time
	to        time.Time
	surface   string
	granule   string
	groupBy   string
	errorOnly bool
	limit     int
}

func (s *fakeTelemetryStore) OverviewStats(_ context.Context, from, to time.Time, surface string) (models.TelemetryOverview, error) {
	s.overviewCalls = append(s.overviewCalls, fakeTelemetryCall{from: from, to: to, surface: surface})
	return s.overview, s.overviewErr
}

func (s *fakeTelemetryStore) TimeBuckets(_ context.Context, from, to time.Time, granularity, surface string, errorsOnly bool, limit int) ([]models.TelemetryBucketPoint, error) {
	s.bucketCalls = append(s.bucketCalls, fakeTelemetryCall{from: from, to: to, surface: surface, granule: granularity, errorOnly: errorsOnly, limit: limit})
	return s.buckets, s.bucketErr
}

func (s *fakeTelemetryStore) UpstreamGroups(_ context.Context, from, to time.Time, groupBy, surface string, limit int) ([]models.TelemetryUpstreamGroup, error) {
	s.groupCalls = append(s.groupCalls, fakeTelemetryCall{from: from, to: to, surface: surface, groupBy: groupBy, limit: limit})
	return s.groups, s.groupErr
}

func (s *fakeTelemetryStore) UsageTotals(_ context.Context, from, to time.Time, surface string) (models.TelemetryUsageTotals, error) {
	s.usageCalls = append(s.usageCalls, fakeTelemetryCall{from: from, to: to, surface: surface})
	return s.usage, s.usageErr
}

func (s *fakeTelemetryStore) ClientUsage(_ context.Context, from, to time.Time, surface string, limit int) ([]models.TelemetryClientUsage, error) {
	s.clientCalls = append(s.clientCalls, fakeTelemetryCall{from: from, to: to, surface: surface, limit: limit})
	return s.clients, s.clientErr
}

func (s *fakeTelemetryStore) GetRequest(_ context.Context, id int64) (models.RequestHistory, error) {
	s.requestCalls = append(s.requestCalls, id)
	if s.requestErr != nil {
		return models.RequestHistory{}, s.requestErr
	}
	return s.request, nil
}

func fixedTelemetryNow() time.Time {
	return time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
}

func TestAdminTelemetryWindowRespectsExplicitBounds(t *testing.T) {
	from, to, err := adminTelemetryWindow(TelemetryQuery{From: "2026-08-13T10:00:00Z", To: "2026-08-13T11:30:00Z"}, fixedTelemetryNow())
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 8, 13, 10, 0, 0, 0, time.UTC); !from.Equal(want) {
		t.Fatalf("from = %v want %v", from, want)
	}
	if want := time.Date(2026, 8, 13, 11, 30, 0, 0, time.UTC); !to.Equal(want) {
		t.Fatalf("to = %v want %v", to, want)
	}
}

func TestAdminTelemetryWindowPeriodShortcuts(t *testing.T) {
	now := fixedTelemetryNow()
	tests := []struct {
		period string
		want   time.Duration
	}{
		{"1h", time.Hour},
		{"24h", 24 * time.Hour},
		{"7d", 7 * 24 * time.Hour},
		{"30d", 30 * 24 * time.Hour},
		{"", 24 * time.Hour},
	}
	for _, tc := range tests {
		from, to, err := adminTelemetryWindow(TelemetryQuery{Period: tc.period}, now)
		if err != nil {
			t.Fatalf("period %q: %v", tc.period, err)
		}
		if !to.Equal(now) {
			t.Fatalf("period %q: to = %v want %v", tc.period, to, now)
		}
		if got := to.Sub(from); got != tc.want {
			t.Fatalf("period %q: window = %v want %v", tc.period, got, tc.want)
		}
	}
	from, _, err := adminTelemetryWindow(TelemetryQuery{Period: "all"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !from.IsZero() {
		t.Fatalf("period all: from = %v want zero", from)
	}
}

func TestAdminTelemetryWindowRejectsInvalidBounds(t *testing.T) {
	if _, _, err := adminTelemetryWindow(TelemetryQuery{From: "not-a-timestamp"}, fixedTelemetryNow()); err == nil {
		t.Fatal("invalid from accepted")
	}
	if _, _, err := adminTelemetryWindow(TelemetryQuery{To: "2026-13-45T00:00:00Z"}, fixedTelemetryNow()); err == nil {
		t.Fatal("invalid to accepted")
	}
}

func TestAdminTelemetryWindowInvertedBoundsAreEmpty(t *testing.T) {
	from, to, err := adminTelemetryWindow(TelemetryQuery{From: "2026-08-13T11:00:00Z", To: "2026-08-13T10:00:00Z"}, fixedTelemetryNow())
	if err != nil {
		t.Fatal(err)
	}
	if !from.Equal(to) {
		t.Fatalf("inverted window = [%v,%v) want equal bounds", from, to)
	}
}

func TestAdminTelemetryBucketAutoResolution(t *testing.T) {
	now := fixedTelemetryNow()
	tests := []struct {
		window time.Duration
		want   string
	}{
		{time.Hour, "minute"},
		{2 * time.Hour, "minute"},
		{24 * time.Hour, "hour"},
		{14 * 24 * time.Hour, "hour"},
		{30 * 24 * time.Hour, "day"},
	}
	for _, tc := range tests {
		if got := adminTelemetryBucket(TelemetryQuery{}, now.Add(-tc.window), now); got != tc.want {
			t.Fatalf("auto bucket for %v = %q want %q", tc.window, got, tc.want)
		}
	}
	if got := adminTelemetryBucket(TelemetryQuery{Bucket: "minute"}, now.Add(-24*time.Hour), now); got != "minute" {
		t.Fatalf("explicit bucket overridden: %q", got)
	}
}

func TestPostgresTelemetryAdminServiceOverview(t *testing.T) {
	store := &fakeTelemetryStore{overview: models.TelemetryOverview{
		Requests: 12, Errors: 3, P50MS: 100, P95MS: 900, P99MS: 1500,
		ByRoute: map[string]int64{"daemon.proxy": 12},
	}}
	service := newPostgresTelemetryAdminService(store)
	service.now = fixedTelemetryNow
	overview, err := service.Overview(context.Background(), TelemetryQuery{Period: "24h"})
	if err != nil {
		t.Fatal(err)
	}
	if overview.Requests != 12 || overview.Errors != 3 || overview.P50 != 100 || overview.P95 != 900 || overview.P99 != 1500 {
		t.Fatalf("overview = %#v", overview)
	}
	if overview.ByRoute["daemon.proxy"] != 12 {
		t.Fatalf("byRoute = %#v", overview.ByRoute)
	}
	if len(store.overviewCalls) != 1 || !store.overviewCalls[0].to.Equal(fixedTelemetryNow()) {
		t.Fatalf("store calls = %#v", store.overviewCalls)
	}
}

func TestPostgresTelemetryAdminServiceEmptyDataIsNotAnError(t *testing.T) {
	service := newPostgresTelemetryAdminService(&fakeTelemetryStore{})
	overview, err := service.Overview(context.Background(), TelemetryQuery{})
	if err != nil || overview.Requests != 0 || overview.ByRoute != nil {
		t.Fatalf("overview = %#v err=%v", overview, err)
	}
	buckets, err := service.Requests(context.Background(), TelemetryQuery{})
	if err != nil || len(buckets) != 0 {
		t.Fatalf("requests = %#v err=%v", buckets, err)
	}
	upstream, err := service.Upstream(context.Background(), TelemetryQuery{})
	if err != nil || len(upstream) != 0 {
		t.Fatalf("upstream = %#v err=%v", upstream, err)
	}
}

func TestPostgresTelemetryAdminServiceRequestsAndErrorsBuckets(t *testing.T) {
	store := &fakeTelemetryStore{buckets: []models.TelemetryBucketPoint{
		{Timestamp: time.Date(2026, 8, 16, 11, 0, 0, 0, time.UTC), Count: 5, Errors: 1, LatencyMS: 250},
	}}
	service := newPostgresTelemetryAdminService(store)
	service.now = fixedTelemetryNow
	query := TelemetryQuery{Period: "24h", Bucket: "hour", Limit: 10000, Surface: "client_action"}
	buckets, err := service.Requests(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 || buckets[0].Timestamp != "2026-08-16T11:00:00Z" || buckets[0].Count != 5 || buckets[0].Errors != 1 || buckets[0].LatencyMS != 250 {
		t.Fatalf("buckets = %#v", buckets)
	}
	call := store.bucketCalls[0]
	if call.granule != "hour" || call.surface != "client_action" || call.errorOnly || call.limit != maxAdminTelemetryLimit {
		t.Fatalf("requests call = %#v", call)
	}
	errorBuckets, err := service.Errors(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(errorBuckets) != 1 {
		t.Fatalf("error buckets = %#v", errorBuckets)
	}
	if !store.bucketCalls[1].errorOnly {
		t.Fatalf("errors call = %#v", store.bucketCalls[1])
	}
}

func TestPostgresTelemetryAdminServiceUpstreamGroups(t *testing.T) {
	store := &fakeTelemetryStore{groups: []models.TelemetryUpstreamGroup{
		{Provider: "openai", Count: 7, Errors: 2, LatencyMS: 400},
		{Provider: "anthropic", Model: "claude-3", Count: 4, LatencyMS: 300},
	}}
	service := newPostgresTelemetryAdminService(store)
	service.now = fixedTelemetryNow
	buckets, err := service.Upstream(context.Background(), TelemetryQuery{GroupBy: "model"})
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 2 {
		t.Fatalf("buckets = %#v", buckets)
	}
	if buckets[0].Metadata["provider"] != "openai" {
		t.Fatalf("metadata = %#v", buckets[0].Metadata)
	}
	if _, ok := buckets[0].Metadata["model"]; ok {
		t.Fatalf("unexpected model on empty group: %#v", buckets[0].Metadata)
	}
	if buckets[1].Metadata["model"] != "claude-3" {
		t.Fatalf("metadata = %#v", buckets[1].Metadata)
	}
	if buckets[0].Timestamp != "2026-08-16T12:00:00Z" {
		t.Fatalf("timestamp = %q", buckets[0].Timestamp)
	}
}

func TestPostgresTelemetryAdminServiceWrapsStoreErrors(t *testing.T) {
	service := newPostgresTelemetryAdminService(&fakeTelemetryStore{overviewErr: errors.New("boom")})
	if _, err := service.Overview(context.Background(), TelemetryQuery{}); err == nil {
		t.Fatal("overview error swallowed")
	}
}

func TestPostgresUsageAdminServiceUsage(t *testing.T) {
	store := &fakeTelemetryStore{usage: models.TelemetryUsageTotals{
		Requests: 9, InputTokens: 100, OutputTokens: 50, TotalTokens: 150,
		ByProvider: map[string]int64{"openai": 150}, ByModel: map[string]int64{"gpt-x": 150},
	}}
	service := newPostgresUsageAdminService(store)
	service.now = fixedTelemetryNow
	summary, err := service.Usage(context.Background(), TelemetryQuery{Period: "7d"})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Requests != 9 || summary.InputTokens == nil || *summary.InputTokens != 100 || *summary.OutputTokens != 50 || *summary.TotalTokens != 150 {
		t.Fatalf("summary = %#v", summary)
	}
	if !reflect.DeepEqual(summary.ByProvider, map[string]int64{"openai": 150}) {
		t.Fatalf("byProvider = %#v", summary.ByProvider)
	}
}

func TestPostgresUsageAdminServiceUsageWithoutData(t *testing.T) {
	service := newPostgresUsageAdminService(&fakeTelemetryStore{})
	summary, err := service.Usage(context.Background(), TelemetryQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Requests != 0 || summary.InputTokens != nil || summary.TotalTokens != nil || summary.ByProvider != nil {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestPostgresUsageAdminServiceClients(t *testing.T) {
	store := &fakeTelemetryStore{clients: []models.TelemetryClientUsage{
		{Client: "claude-cli", Source: "user_agent", Count: 3},
		{Client: "unknown", Source: "proxy", Count: 1},
	}}
	service := newPostgresUsageAdminService(store)
	service.now = fixedTelemetryNow
	dist, err := service.Clients(context.Background(), TelemetryQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if dist.Total != 4 || dist.Unknown != 1 {
		t.Fatalf("distribution = %#v", dist)
	}
	if len(dist.Items) != 2 {
		t.Fatalf("items = %#v", dist.Items)
	}
	if dist.Items[0].Client != "claude-cli" || dist.Items[0].Percentage != 75 || dist.Items[0].Confidence != "observed" {
		t.Fatalf("item = %#v", dist.Items[0])
	}
	if dist.Items[1].Client != "unknown" || dist.Items[1].Percentage != 25 || dist.Items[1].Confidence != "" {
		t.Fatalf("item = %#v", dist.Items[1])
	}
}

func TestPostgresUsageAdminServiceClientsWithoutData(t *testing.T) {
	service := newPostgresUsageAdminService(&fakeTelemetryStore{})
	dist, err := service.Clients(context.Background(), TelemetryQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if dist.Total != 0 || len(dist.Items) != 0 {
		t.Fatalf("distribution = %#v", dist)
	}
}

func TestAdminTelemetryLimitClamp(t *testing.T) {
	if got := adminTelemetryLimit(0); got != maxAdminTelemetryLimit {
		t.Fatalf("limit(0) = %d", got)
	}
	if got := adminTelemetryLimit(10000); got != maxAdminTelemetryLimit {
		t.Fatalf("limit(10000) = %d", got)
	}
	if got := adminTelemetryLimit(25); got != 25 {
		t.Fatalf("limit(25) = %d", got)
	}
}

func TestPostgresTelemetryAdminServiceRequestDetailSuccess(t *testing.T) {
	in := int64(7)
	tokens := 11
	outTokens := 13
	started := time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC)
	finished := started.Add(1500 * time.Millisecond)
	store := &fakeTelemetryStore{request: models.RequestHistory{
		ID: in, TraceID: "trace-7", Endpoint: "chat", Surface: "client_action",
		APIKeyID: "key", APIKeyPrefix: "abc", Provider: "openai", Model: "gpt-x",
		Status: 200, ErrorKind: "", Stream: true,
		StartedAt: started, FinishedAt: finished, DurationMs: 1500,
		InputTokens: &tokens, OutputTokens: &outTokens,
		ClientName: "curl", ClientSource: "user_agent", ClientIP: "10.0.0.1",
	}}
	service := newPostgresTelemetryAdminService(store)
	detail, err := service.RequestDetail(context.Background(), "7")
	if err != nil {
		t.Fatal(err)
	}
	if detail.ID != "7" || detail.TraceID != "trace-7" || detail.Provider != "openai" || detail.Model != "gpt-x" ||
		detail.Status != 200 || detail.LatencyMs != 1500 || detail.InputTokens != 11 || detail.OutputTokens != 13 ||
		detail.ClientIP != "10.0.0.1" || detail.ClientName != "curl" || !detail.Stream ||
		detail.StartedAt != "2026-08-16T10:00:00Z" || detail.FinishedAt != "2026-08-16T10:00:01Z" {
		t.Fatalf("detail = %#v", detail)
	}
	if len(store.requestCalls) != 1 || store.requestCalls[0] != 7 {
		t.Fatalf("store calls = %#v", store.requestCalls)
	}
}

func TestPostgresTelemetryAdminServiceRequestDetailNotFound(t *testing.T) {
	service := newPostgresTelemetryAdminService(&fakeTelemetryStore{requestErr: sql.ErrNoRows})
	if _, err := service.RequestDetail(context.Background(), "42"); err == nil {
		t.Fatal("expected not found error")
	} else if code := adminCode(err); code != CodeNotFound {
		t.Fatalf("err code = %s want not_found", code)
	}
}

func TestPostgresTelemetryAdminServiceRequestDetailInvalidID(t *testing.T) {
	store := &fakeTelemetryStore{}
	service := newPostgresTelemetryAdminService(store)
	for _, id := range []string{"", "   ", "abc", "0", "-1"} {
		_, err := service.RequestDetail(context.Background(), id)
		if code := adminCode(err); code != CodeNotFound {
			t.Fatalf("id=%q err code = %s want not_found", id, code)
		}
	}
	if len(store.requestCalls) != 0 {
		t.Fatalf("store calls = %#v", store.requestCalls)
	}
}

func TestPostgresTelemetryAdminServiceRequestDetailStoreError(t *testing.T) {
	service := newPostgresTelemetryAdminService(&fakeTelemetryStore{requestErr: errors.New("boom")})
	_, err := service.RequestDetail(context.Background(), "9")
	if code := adminCode(err); code != CodeAdminUnavailable {
		t.Fatalf("err code = %s want unavailable", code)
	}
}

// adminCode extracts the operator-safe ErrorCode from an admin error if any.
func adminCode(err error) ErrorCode {
	var adminErr *Error
	if errors.As(err, &adminErr) {
		return adminErr.Code
	}
	return ""
}
