package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/cartethyia/daemon/internal/telemetry"
)

type metadataTelemetryStub struct {
	row  models.RequestHistory
	rows []models.RequestHistory
}

func (s *metadataTelemetryStub) InsertRequest(_ context.Context, row models.RequestHistory) (models.RequestHistory, error) {
	s.row = row
	return row, nil
}
func (s *metadataTelemetryStub) InsertRequestsBatch(_ context.Context, rows []models.RequestHistory) error {
	s.rows = append([]models.RequestHistory(nil), rows...)
	return nil
}
func (s *metadataTelemetryStub) GetRequest(context.Context, int64) (models.RequestHistory, error) {
	return models.RequestHistory{}, nil
}
func (s *metadataTelemetryStub) GetRequestByTrace(context.Context, string) (models.RequestHistory, error) {
	return models.RequestHistory{}, nil
}
func (s *metadataTelemetryStub) ListRequestsByAPIKey(context.Context, string, int) ([]models.RequestHistory, error) {
	return nil, nil
}
func (s *metadataTelemetryStub) ListRequestsOlderThan(context.Context, string, int) ([]models.RequestHistory, error) {
	return nil, nil
}
func (s *metadataTelemetryStub) DeleteRequestsOlderThan(context.Context, string) (int64, error) {
	return 0, nil
}
func (s *metadataTelemetryStub) UpsertPayload(context.Context, models.RequestPayload) (models.RequestPayload, error) {
	return models.RequestPayload{}, nil
}
func (s *metadataTelemetryStub) GetPayload(context.Context, string) (models.RequestPayload, error) {
	return models.RequestPayload{}, nil
}
func (s *metadataTelemetryStub) DeletePayloadsOlderThan(context.Context, string) (int64, error) {
	return 0, nil
}
func (s *metadataTelemetryStub) InsertConsoleLog(context.Context, models.ConsoleLog) error {
	return nil
}
func (s *metadataTelemetryStub) ListConsoleLogs(context.Context, string, int) ([]models.ConsoleLog, error) {
	return nil, nil
}
func (s *metadataTelemetryStub) DeleteConsoleLogsOlderThan(context.Context, string) (int64, error) {
	return 0, nil
}

func TestMetadataSinkMapsBoundedPayloadFreeHistory(t *testing.T) {
	stub := &metadataTelemetryStub{}
	sink := NewMetadataSinkAdapter(stub)
	started := time.Now().UTC()
	in := int64(17)
	if err := sink.WriteMetadata(context.Background(), telemetry.Metadata{
		RequestID: strings.Repeat("r", 200), Provider: "authorization-secret", Model: "model",
		Surface: "openai-chat", Outcome: telemetry.OutcomeSuccess, StartedAt: started,
		EndedAt: started.Add(23 * time.Millisecond), LatencyMS: 23, MessageCount: -1,
		ToolCount: -2, ImageCount: -3, InputTokens: &in,
	}); err != nil {
		t.Fatal(err)
	}
	row := stub.row
	if len(row.TraceID) != 96 || row.Provider != "[redacted]" || row.Endpoint != "daemon.proxy" || row.Surface != "openai-chat" {
		t.Fatalf("mapped identity = %#v", row)
	}
	if row.Status != 200 || row.DurationMs != 23 || row.MessageCount != 0 || row.ToolCount != 0 || row.ImageCount != 0 {
		t.Fatalf("mapped bounds = %#v", row)
	}
	if row.InputTokens == nil || *row.InputTokens != 17 || len(row.MetaJSON) == 0 {
		t.Fatalf("mapped metadata = %#v", row)
	}
	var meta map[string]any
	if err := json.Unmarshal(row.MetaJSON, &meta); err != nil {
		t.Fatal(err)
	}
	if _, hasPayload := meta["payload"]; hasPayload || strings.Contains(string(row.MetaJSON), "authorization-secret") {
		t.Fatalf("metadata unexpectedly captured payload/secret: %s", row.MetaJSON)
	}
}

func TestMetadataSinkBatchMapsRowsWithoutPayloads(t *testing.T) {
	stub := &metadataTelemetryStub{}
	sink := NewMetadataSinkAdapter(stub)
	if err := sink.WriteMetadataBatch(context.Background(), []telemetry.Metadata{
		{RequestID: "batch-1", Provider: "openai", Model: "gpt", Surface: "chat", Outcome: telemetry.OutcomeSuccess},
		{RequestID: "batch-2", Provider: "refresh_token=secret", Model: "gpt", Surface: "chat", Outcome: telemetry.OutcomeQuota},
	}); err != nil {
		t.Fatal(err)
	}
	if len(stub.rows) != 2 || stub.rows[0].TraceID != "batch-1" || stub.rows[1].Provider != "[redacted]" {
		t.Fatalf("batch mapping = %#v", stub.rows)
	}
	for _, row := range stub.rows {
		if strings.Contains(string(row.MetaJSON), "secret") || strings.Contains(string(row.MetaJSON), "payload") {
			t.Fatalf("batch persisted secret/payload: %s", row.MetaJSON)
		}
	}
}

func TestInsertRequestsBatchRollsBackOnBulkFailure(t *testing.T) {
	db, mock := newFakeBun(t)
	repo := NewBunTelemetryRepository(db)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO .*request_history.*").WillReturnError(errors.New("bulk failure"))
	mock.ExpectRollback()
	err := repo.InsertRequestsBatch(context.Background(), []models.RequestHistory{
		{TraceID: "batch-1", Endpoint: "daemon.proxy", Surface: "chat"},
		{TraceID: "batch-2", Endpoint: "daemon.proxy", Surface: "chat"},
	})
	if err == nil || !strings.Contains(err.Error(), "bulk failure") {
		t.Fatalf("batch failure = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRequestsBatchPersistsRowsInOneTransaction(t *testing.T) {
	db, mock := newFakeBun(t)
	repo := NewBunTelemetryRepository(db)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO .*request_history.*").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1).AddRow(2))
	mock.ExpectCommit()
	if err := repo.InsertRequestsBatch(context.Background(), []models.RequestHistory{
		{TraceID: "batch-1", Endpoint: "daemon.proxy", Surface: "chat"},
		{TraceID: "batch-2", Endpoint: "daemon.proxy", Surface: "chat"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
