package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/storage/models"
)

// TelemetryRepository owns the request_history, request_payloads, and
// console_logs tables. Bounded retention writers live here too.
type TelemetryRepository interface {
	InsertRequest(ctx context.Context, r models.RequestHistory) (models.RequestHistory, error)
	InsertRequestsBatch(ctx context.Context, rows []models.RequestHistory) error
	GetRequest(ctx context.Context, id int64) (models.RequestHistory, error)
	GetRequestByTrace(ctx context.Context, traceID string) (models.RequestHistory, error)
	ListRequestsByAPIKey(ctx context.Context, apiKeyID string, limit int) ([]models.RequestHistory, error)
	ListRequestsOlderThan(ctx context.Context, cutoff string, limit int) ([]models.RequestHistory, error)
	DeleteRequestsOlderThan(ctx context.Context, cutoff string) (int64, error)

	UpsertPayload(ctx context.Context, p models.RequestPayload) (models.RequestPayload, error)
	GetPayload(ctx context.Context, requestID string) (models.RequestPayload, error)
	DeletePayloadsOlderThan(ctx context.Context, cutoff string) (int64, error)

	InsertConsoleLog(ctx context.Context, log models.ConsoleLog) error
	ListConsoleLogs(ctx context.Context, scope string, limit int) ([]models.ConsoleLog, error)
	DeleteConsoleLogsOlderThan(ctx context.Context, cutoff string) (int64, error)
}
