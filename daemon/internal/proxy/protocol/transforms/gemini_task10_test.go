package transforms

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestGeminiNativeGoldenRoundTripPreservesPartOrder(t *testing.T) {
	body := []byte(`{"model":"gemini-2.5-pro","systemInstruction":{"parts":[{"text":"system"}]},"contents":[{"role":"user","parts":[{"text":"look"},{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}},{"fileData":{"mimeType":"application/pdf","fileUri":"gs://bucket/doc.pdf"}}]},{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"lookup","args":{"q":"x"}}}]},{"role":"user","parts":[{"functionResponse":{"id":"call-1","name":"lookup","response":{"ok":true}}}]}],"tools":[{"functionDeclarations":[{"name":"lookup","description":"Lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}]}],"generationConfig":{"maxOutputTokens":128,"responseMimeType":"application/json","responseSchema":{"type":"object"}}}`)
	request, decodeErr := NewGeminiRequestDecoder().Decode(context.Background(), body, false)
	if decodeErr != nil { t.Fatal(decodeErr) }
	if len(request.Messages) != 4 || request.Messages[2].Content[0].Type != BlockToolUse || request.Messages[3].Content[0].Type != BlockToolResult { t.Fatalf("messages=%#v", request.Messages) }
	encoded, encodeErr := NewGeminiCodec().Encode(context.Background(), request)
	if encodeErr != nil { t.Fatal(encodeErr) }
	wire, err := json.Marshal(encoded.Wire)
	if err != nil { t.Fatal(err) }
	decoded, decodeErr := NewGeminiRequestDecoder().Decode(context.Background(), wire, false)
	if decodeErr != nil { t.Fatal(decodeErr) }
	if got := decoded.Messages[0].Content[0].Text; got != "system" { t.Fatalf("system text=%q", got) }
	if got := decoded.Messages[1].Content[1].Type; got != BlockImage { t.Fatalf("media type=%q", got) }
	if got := decoded.Messages[2].Content[0].ToolCallID; got != "call-1" { t.Fatalf("call id=%q", got) }
}

func TestGeminiRegistryIncludesNativeIngress(t *testing.T) {
	registry := NewDefaultRegistry()
	decoder, ok := registry.LookupDecoder(contracts.ProtocolGemini)
	if !ok || decoder == nil { t.Fatal("Gemini decoder not registered") }
	encoder, ok := registry.LookupRequest(contracts.ProtocolGemini)
	if !ok || encoder == nil { t.Fatal("Gemini encoder not registered") }
}

func TestCompactionCodecV1AndV2Bridge(t *testing.T) {
	request, err := NewCompactionRequest(CompactionRequestInput{Version: CompactionV1, Model: "gpt-5", Input: []CompactionItem{{Type: BlockText, Text: "history"}}})
	if err != nil { t.Fatal(err) }
	operation, err := NewCompactionOperation(request)
	if err != nil { t.Fatal(err) }
	input := &NormalizedRequest{Model: "gpt-5", Source: contracts.ProtocolOpenAIResponse, Operation: operation}
	encoded, encodeErr := EncodeCompactionRequest(context.Background(), contracts.ProtocolOpenAIResponse, input)
	if encodeErr != nil { t.Fatal(encodeErr) }
	if encoded.Wire["compact"] != true { t.Fatalf("v1 wire=%#v", encoded.Wire) }
	bridged, bridgeErr := BridgeCompactionRequest(request, CompactionV2)
	if bridgeErr != nil { t.Fatal(bridgeErr) }
	if bridged.Version != CompactionV2 || bridged.Input[len(bridged.Input)-1].Type != BlockCompactionTrigger { t.Fatalf("bridge=%#v", bridged) }
}
