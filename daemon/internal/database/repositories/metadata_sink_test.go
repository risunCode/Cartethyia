package repositories

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/cartethyia/daemon/internal/observability"
)

type metadataTelemetryStub struct{ row models.RequestHistory }

func (s *metadataTelemetryStub) InsertRequest(_ context.Context, row models.RequestHistory) (models.RequestHistory, error) {
	s.row = row
	return row, nil
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
	if err := sink.WriteMetadata(context.Background(), observability.Metadata{
		RequestID: strings.Repeat("r", 200), Provider: "authorization-secret", Model: "model",
		Surface: "openai-chat", Outcome: observability.OutcomeSuccess, StartedAt: started,
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
