package models

import "time"

// ShareUsage is a bounded aggregate used by the public monitor boundary.
// It intentionally contains no client IP, provider, or model dimensions.
type ShareUsage struct {
	TotalRequests   int64
	TotalTokens     int64
	DailyRequests   int64
	DailyTokens     int64
	MonthlyRequests int64
	MonthlyTokens   int64
}

// RequestHistory is one proxy invocation record (request_history).
type RequestHistory struct {
	ID               int64
	TraceID          string
	Endpoint         string
	Surface          string
	APIKeyID         string
	APIKeyPrefix     string
	Provider         string
	Model            string
	Status           int
	ErrorKind        string
	Stream           bool
	StartedAt        time.Time
	FinishedAt       time.Time
	DurationMs       int
	InputTokens      *int
	OutputTokens     *int
	CachedTokens     *int
	CacheWriteTokens *int
	ReasoningTokens  *int
	TotalTokens      *int
	UsageSource      string
	MetaJSON         []byte
	ClientName       string
	ClientSource     string
	MessageCount     int
	ToolCount        int
	ImageCount       int
	TFFTMs           *int
	ClientIP         string
}

// RequestPayload holds captured request/response bodies for a trace
// (request_payloads).
type RequestPayload struct {
	RequestID            string
	ClientRequest        []byte
	ProviderRequest      []byte
	ProviderResponse     []byte
	ClientResponse       []byte
	ClientRequestMeta    []byte
	ProviderRequestMeta  []byte
	ProviderResponseMeta []byte
	ClientResponseMeta   []byte
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// ConsoleLog is an operator-visible structured log entry (console_logs).
type ConsoleLog struct {
	ID      int64
	TS      time.Time
	Level   string
	Scope   string
	Message string
}

// TelemetryOverview is the bounded summary row for admin overview reads. It
// carries only aggregate counts and latency percentiles; no request content,
// client identity, or credential-shaped value is representable here.
type TelemetryOverview struct {
	Requests int64
	Errors   int64
	P50MS    int64
	P95MS    int64
	P99MS    int64
	ByRoute  map[string]int64
}

// TelemetryBucketPoint is one time-bucketed aggregate over request_history.
type TelemetryBucketPoint struct {
	Timestamp time.Time
	Count     int64
	Errors    int64
	LatencyMS int64
}

// TelemetryUpstreamGroup is one provider (or provider/model) aggregate.
type TelemetryUpstreamGroup struct {
	Provider  string
	Model     string
	Count     int64
	Errors    int64
	LatencyMS int64
}

// TelemetryUsageTotals is the bounded token usage aggregate for admin reads.
// Group maps values are total token sums, never per-request detail.
type TelemetryUsageTotals struct {
	Requests     int64
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
	ByProvider   map[string]int64
	ByModel      map[string]int64
}

// TelemetryClientUsage is one client-family distribution row. Source mirrors
// the persisted client_source classification, not free-form client input.
type TelemetryClientUsage struct {
	Client string
	Source string
	Count  int64
}

// ConsoleLogFilter is the bounded filter for operator console evidence reads.
type ConsoleLogFilter struct {
	From  time.Time
	To    time.Time
	Level string
	Scope string
	Limit int
}
