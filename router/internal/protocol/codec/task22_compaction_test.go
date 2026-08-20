package codec

import (
	"context"
	"encoding/json"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestTask22CompactionV1V2RoundTripAndBridgeSemantics(t *testing.T) {
	ctx := context.Background()
	v1, err := NewCompactionRequest(CompactionRequestInput{Version: CompactionV1, Model: "fixture-model", Input: []CompactionItem{{Type: BlockText, Text: "history"}}})
	if err != nil {
		t.Fatal(err)
	}
	v1Op, err := NewCompactionOperation(v1)
	if err != nil {
		t.Fatal(err)
	}
	v1Req := &NormalizedRequest{Model: v1.Model, Source: contracts.ProtocolOpenAIResponse, Operation: v1Op}
	v1Wire, terr := EncodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, v1Req)
	if terr != nil {
		t.Fatal(terr)
	}
	if v1Wire.Wire["compact"] != true {
		t.Fatalf("v1 wire=%#v", v1Wire.Wire)
	}

	v2, terr := BridgeCompactionRequest(v1, CompactionV2)
	if terr != nil {
		t.Fatal(terr)
	}
	if v2.Version != CompactionV2 || len(v2.Input) == 0 || v2.Input[len(v2.Input)-1].Type != BlockCompactionTrigger {
		t.Fatalf("v2 bridge=%#v", v2)
	}
	v2Op, err := NewCompactionOperation(v2)
	if err != nil {
		t.Fatal(err)
	}
	v2Req := &NormalizedRequest{Model: v2.Model, Source: contracts.ProtocolOpenAIResponse, Operation: v2Op}
	v2Wire, terr := EncodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, v2Req)
	if terr != nil {
		t.Fatal(terr)
	}
	input, ok := v2Wire.Wire["input"].([]map[string]any)
	if !ok || len(input) == 0 || input[len(input)-1]["type"] != string(CompactionItemTrigger) {
		t.Fatalf("v2 wire=%#v", v2Wire.Wire)
	}

	v1Back, terr := BridgeCompactionRequest(v2, CompactionV1)
	if terr != nil {
		t.Fatal(terr)
	}
	if v1Back.Version != CompactionV1 || v1Back.Input[len(v1Back.Input)-1].Type == BlockCompactionTrigger {
		t.Fatalf("v1 bridge back=%#v", v1Back)
	}
}

func TestTask22CompactionDecoderRejectsInvalidShapeWithoutPanic(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name    string
		body    []byte
		version CompactionVersion
		code    TransformErrorCode
	}{
		{"v1-trigger", []byte(`{"model":"fixture-model","input":[{"type":"compaction_trigger"} ]}`), CompactionV1, CodeInvalidCompaction},
		{"v2-no-trigger", []byte(`{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"history"}]}]}`), CompactionV2, CodeInvalidCompaction},
		{"empty-input", []byte(`{"model":"fixture-model","input":[]}`), CompactionV1, CodeInvalidCompaction},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, tc.body, tc.version, false)
			if err == nil || err.Code != tc.code {
				t.Fatalf("error=%v, want %s", err, tc.code)
			}
		})
	}
}

func TestTask22CompactionCancellationReturnsTypedError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body := []byte(`{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"history"}]},{"type":"compaction_trigger"}]}`)
	_, err := DecodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, body, CompactionV2, true)
	if err == nil || err.Code != CodeContextCanceled {
		t.Fatalf("decode cancellation error=%v", err)
	}
	requestInput := CompactionRequestInput{
		Version: CompactionV2,
		Model:   "fixture-model",
		Input: []CompactionItem{{
			Type:       BlockCompactionTrigger,
			Compaction: &CompactionContent{Version: CompactionV2, Kind: CompactionItemTrigger},
		}},
	}
	request, buildErr := NewCompactionRequest(requestInput)
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	operation, buildErr := NewCompactionOperation(request)
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	_, err = EncodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, &NormalizedRequest{Model: request.Model, Source: contracts.ProtocolOpenAIResponse, Operation: operation})
	if err == nil || err.Code != CodeContextCanceled {
		t.Fatalf("encode cancellation error=%v", err)
	}
}

func TestTask22ToolOccurrencePairingPreservesKindsAndNeverFabricatesSuccess(t *testing.T) {
	req := &NormalizedRequest{Model: "fixture-model", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{
		{Type: BlockToolUse, ToolKind: ToolKindFunction, ToolCallID: "same", ToolName: "first", ToolArguments: `{"n":1}`},
		{Type: BlockToolUse, ToolKind: ToolKindCustom, ToolCallID: "same", ToolName: "second", ToolArguments: `{"n":2}`},
	}}, {Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "same", ToolResult: "first-result"}, {Type: BlockToolResult, ToolCallID: "same", ToolResult: "second-result"}}}}}
	result, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || report.DuplicateResults != 1 {
		t.Fatalf("paired result=%#v report=%#v", result, report)
	}
	if result.ToolLedger == nil || result.ToolLedger.Len() != 2 {
		t.Fatalf("ledger=%#v", result.ToolLedger)
	}
	for _, message := range result.Messages {
		for _, block := range message.Content {
			if block.Type == BlockToolResult && block.ToolResult == "" && !block.ToolResultIsError {
				t.Fatal("fabricated empty success result")
			}
		}
	}
}

func TestTask22MediaReferencesRetainReferenceAndOrderSemantics(t *testing.T) {
	urlRef, err := NewMediaReference(MediaImage, ReferenceURL, "https://example.invalid/image.png", MediaReferenceOptions{MIMEType: "image/png", Detail: ImageDetailHigh})
	if err != nil {
		t.Fatal(err)
	}
	fileRef, err := NewPDFReference(ReferenceProviderFileID, "file_fixture_pdf", MediaReferenceOptions{MIMEType: "application/pdf", Filename: "fixture.pdf"})
	if err != nil {
		t.Fatal(err)
	}
	imageRef := ImageReference{Kind: ImageURL, Value: urlRef.Value, MediaType: urlRef.MIMEType, Detail: urlRef.Detail}
	req := &NormalizedRequest{Model: "fixture-model", Source: contracts.ProtocolOpenAIResponse, Messages: []NormalizedMessage{{Role: RoleUser, Content: []ContentBlock{{Type: BlockImage, Image: &imageRef}, {Type: BlockPDF, File: &fileRef}}}}}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	encoded, terr := NewOpenAIResponsesCodec().Encode(context.Background(), req)
	if terr != nil {
		t.Fatal(terr)
	}
	body, marshalErr := json.Marshal(encoded.Wire)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	decoded, terr := NewOpenAIResponsesRequestDecoder().Decode(context.Background(), body, false)
	if terr != nil {
		t.Fatal(terr)
	}
	if len(decoded.Messages) != 1 || len(decoded.Messages[0].Content) != 2 {
		t.Fatalf("decoded=%#v", decoded.Messages)
	}
	if decoded.Messages[0].Content[0].Type != BlockImage || decoded.Messages[0].Content[1].Type != BlockPDF {
		t.Fatalf("content order=%#v", decoded.Messages[0].Content)
	}
}

func TestTask22TerminalEncodersEmitOneTypedTerminal(t *testing.T) {
	ctx := context.Background()
	for _, encoder := range []ResponseEncoder{NewOpenAIChatResponseEncoder(), NewOpenAIResponsesResponseEncoder(), NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
		terminal := &NormalizedEvent{Type: EventResponseCompleted, Status: ItemStatusCompleted}
		frame, err := encoder.EncodeEvent(ctx, terminal)
		if err != nil || frame == nil {
			t.Fatalf("surface=%s frame=%#v err=%v", encoder.Protocol(), frame, err)
		}
		if len(frame) == 0 {
			t.Fatalf("surface=%s emitted empty terminal", encoder.Protocol())
		}
	}
}
