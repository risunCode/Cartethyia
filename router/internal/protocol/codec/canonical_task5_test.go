package codec

import (
	"encoding/base64"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestTask5MediaReferencesRetainTypedReferenceSemantics(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("pdf"))
	pdf, err := NewPDFReference(ReferenceInlineData, data, MediaReferenceOptions{MIMEType: "application/pdf", Filename: "context.pdf"})
	if err != nil {
		t.Fatalf("NewPDFReference: %v", err)
	}
	if pdf.Media != MediaPDF || pdf.Reference != ReferenceInlineData || pdf.Filename != "context.pdf" {
		t.Fatalf("unexpected PDF reference: %#v", pdf)
	}
	block := ContentBlock{Type: BlockDocument, Document: &pdf}
	req := &NormalizedRequest{Model: "gpt-5", Source: contracts.ProtocolOpenAIResponse, Messages: []NormalizedMessage{{Role: RoleUser, Content: []ContentBlock{block}}}}
	if err := req.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestTask5CompactionOperationVersionAndResultBounds(t *testing.T) {
	request, err := NewCompactionRequest(CompactionRequestInput{
		Version: CompactionV2,
		Model:   "gpt-5",
		Input:   []CompactionItem{{Type: BlockCompactionTrigger, Compaction: &CompactionContent{Version: CompactionV2, Kind: CompactionItemTrigger}}},
	})
	if err != nil {
		t.Fatalf("NewCompactionRequest: %v", err)
	}
	op, err := NewCompactionOperation(request)
	if err != nil || op.Kind != OperationCompactV2 {
		t.Fatalf("operation = %#v, err=%v", op, err)
	}
	if got := op.Validate(); got != nil {
		t.Fatalf("operation validation: %v", got)
	}
}

func TestTask5ToolOccurrenceLedgerRejectsDuplicateIdentity(t *testing.T) {
	_, err := NewToolOccurrenceLedger([]ToolOccurrence{
		{OccurrenceID: 1, Kind: ToolKindFunction, State: ToolOccurrenceCalled},
		{OccurrenceID: 1, Kind: ToolKindFunction, State: ToolOccurrenceCompleted},
	})
	if err == nil || err.Code != CodeInvalidToolLedger {
		t.Fatalf("expected duplicate occurrence rejection, got %v", err)
	}
}

func TestTask5ResponseValidationPreservesIDsAndUsage(t *testing.T) {
	response := &NormalizedResponse{
		ID: "resp_1", Model: "gpt-5", Status: ItemStatusCompleted,
		Events: []NormalizedEvent{{Type: EventResponseCompleted, ResponseID: "resp_1", Status: ItemStatusCompleted}},
		Usage:  &Usage{InputTokens: 2, OutputTokens: 3, TotalTokens: 5, ReasoningTokens: 1, CacheReadTokens: 1},
	}
	if err := response.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}
