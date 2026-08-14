package repositories

import (
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/database/models"
)

func TestRequestHistoryRowBoundsMetadataAndDefaults(t *testing.T) {
	row, err := requestHistoryRowFromModel(models.RequestHistory{
		TraceID: strings.Repeat("t", maxTelemetryText+20), Endpoint: "chat", Surface: "openai-chat",
		MetaJSON: []byte(`{"safe":true}`),
	})
	if err != nil { t.Fatal(err) }
	if len(row.TraceID) != maxTelemetryText { t.Fatalf("trace id length = %d, want %d", len(row.TraceID), maxTelemetryText) }
	if row.UsageSource != "unknown" || row.ClientName != "unknown" || row.ClientSource != "unknown" { t.Fatalf("defaults were not applied: %#v", row) }
}

func TestRequestHistoryRejectsOversizedMetadata(t *testing.T) {
	_, err := requestHistoryRowFromModel(models.RequestHistory{TraceID: "trace", Endpoint: "endpoint", Surface: "surface", MetaJSON: make([]byte, maxTelemetryMeta+1)})
	if err == nil { t.Fatal("oversized metadata accepted") }
}

func TestPayloadBoundIncludesAllCaptureBuffers(t *testing.T) {
	payload := models.RequestPayload{ClientRequest: make([]byte, maxTelemetryPayload/2), ProviderResponse: make([]byte, maxTelemetryPayload/2+1)}
	if payloadBytes(payload) <= maxTelemetryPayload { t.Fatal("payloadBytes failed to include all buffers") }
}
