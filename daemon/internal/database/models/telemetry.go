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
