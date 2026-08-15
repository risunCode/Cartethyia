package transforms

import (
	"context"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

var task22BenchmarkRequestBody = []byte(`{"model":"fixture-model","messages":[{"role":"system","content":"policy"},{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"lookup","description":"fixture lookup","parameters":{"type":"object"}}}]}`)

func BenchmarkTask22SourceDecode(b *testing.B) {
	decoder := NewOpenAIChatRequestDecoder()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := decoder.Decode(context.Background(), task22BenchmarkRequestBody, false); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22TargetPlanAndProject(b *testing.B) {
	request, err := NewOpenAIChatRequestDecoder().Decode(context.Background(), task22BenchmarkRequestBody, false)
	if err != nil {
		b.Fatal(err)
	}
	encoders := []RequestEncoder{NewOpenAIChatCodec(), NewOpenAIResponsesCodec(), NewAnthropicMessagesCodec(), NewGeminiCodec()}
	b.ReportAllocs()
	for b.Loop() {
		for _, encoder := range encoders {
			if _, terr := encoder.Encode(context.Background(), request); terr != nil {
				b.Fatal(terr)
			}
		}
	}
}

func BenchmarkTask22ToolLedger(b *testing.B) {
	req := &NormalizedRequest{Model: "fixture-model", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolCallID: "fixture-call", ToolName: "lookup", ToolArguments: `{"q":"x"}`}}}, {Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "fixture-call", ToolResult: "ok"}}}}}
	b.ReportAllocs()
	for b.Loop() {
		if _, _, err := NormalizeToolCallInvariants(req, ToolCallInvariantPreserve); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22MediaReferencePlan(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, err := NewMediaReference(MediaImage, ReferenceURL, "https://example.invalid/fixture.png", MediaReferenceOptions{MIMEType: "image/png", Detail: ImageDetailHigh}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTask22CompactionV1V2Bridge(b *testing.B) {
	request, err := NewCompactionRequest(CompactionRequestInput{Version: CompactionV1, Model: "fixture-model", Input: []CompactionItem{{Type: BlockText, Text: "history"}}})
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, terr := BridgeCompactionRequest(request, CompactionV2); terr != nil {
			b.Fatal(terr)
		}
		if _, terr := BridgeCompactionRequest(request, CompactionV1); terr != nil {
			b.Fatal(terr)
		}
	}
}

func BenchmarkTask22ResponseDecodeEncode(b *testing.B) {
	body := []byte(`{"id":"fixture-response","object":"response","model":"fixture-model","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}`)
	decoder := NewOpenAIResponsesResponseDecoder()
	encoder := NewOpenAIResponsesResponseEncoder()
	b.ReportAllocs()
	for b.Loop() {
		response, terr := decoder.Decode(context.Background(), body, "fixture-model")
		if terr != nil {
			b.Fatal(terr)
		}
		if _, terr = encoder.Encode(context.Background(), response); terr != nil {
			b.Fatal(terr)
		}
	}
}

func BenchmarkTask22NativeSidecarMerge(b *testing.B) {
	sidecar := NewNativeSidecar(contracts.ProtocolOpenAIChat)
	if err := sidecar.Add(JSONPointer("/metadata/fixture"), []byte(`{"enabled":true}`), NativeFieldSameSurface); err != nil {
		b.Fatal(err)
	}
	payload := map[string]any{"metadata": map[string]any{}}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := sidecar.ApplySameSurface(contracts.ProtocolOpenAIChat, payload); err != nil {
			b.Fatal(err)
		}
	}
}
