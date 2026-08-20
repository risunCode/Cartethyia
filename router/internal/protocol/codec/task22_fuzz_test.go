package codec

import (
	"context"
	"encoding/json"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func FuzzTask22RequestDecodersNoPanic(f *testing.F) {
	f.Add(uint8(0), []byte(`{"model":"fixture-model","messages":[{"role":"user","content":"hello"}]}`), false)
	f.Add(uint8(1), []byte(`{"model":"fixture-model","input":"hello"}`), true)
	f.Add(uint8(2), []byte(`{"model":"fixture-model","max_tokens":8,"messages":[{"role":"user","content":"hello"}]}`), false)
	f.Add(uint8(3), []byte(`{"model":"fixture-model","contents":[{"role":"user","parts":[{"text":"hello"}]}]}`), false)
	f.Fuzz(func(t *testing.T, surface uint8, body []byte, stream bool) {
		if len(body) > 64*1024 {
			body = body[:64*1024]
		}
		protocols := []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini}
		decoder := NewDefaultRegistry()
		_, _ = decoder.LookupDecoder(protocols[int(surface)%len(protocols)])
		for _, protocol := range protocols {
			d, ok := decoder.LookupDecoder(protocol)
			if !ok {
				t.Fatalf("missing decoder %s", protocol)
			}
			first, firstErr := d.Decode(context.Background(), body, stream)
			_, secondErr := d.Decode(context.Background(), body, stream)
			if (firstErr == nil) != (secondErr == nil) {
				t.Fatalf("nondeterministic decode for %s", protocol)
			}
			if firstErr == nil {
				if first == nil || first.Validate() != nil {
					t.Fatalf("successful decode returned invalid request for %s", protocol)
				}
				for _, target := range []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini} {
					encoder, encoderOK := decoder.LookupRequest(target)
					if !encoderOK {
						t.Fatalf("missing target encoder %s", target)
					}
					_, _ = encoder.Encode(context.Background(), first)
				}
			}
		}
	})
}

func FuzzTask22CompactionAndTargetEncodersNoPanic(f *testing.F) {
	f.Add([]byte(`{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"history"}]},{"type":"compaction_trigger"}]}`), uint8(2))
	f.Add([]byte(`{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"history"}]}]}`), uint8(1))
	f.Fuzz(func(t *testing.T, body []byte, version uint8) {
		if len(body) > 64*1024 {
			body = body[:64*1024]
		}
		v := CompactionVersion(version % 4)
		req, err := DecodeCompactionRequest(context.Background(), contracts.ProtocolOpenAIResponse, body, v, version%2 == 0)
		if err != nil {
			return
		}
		if req == nil || req.Operation.Kind == OperationGenerate {
			t.Fatal("compaction decode returned ordinary operation")
		}
		for _, protocol := range []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini} {
			encoder, ok := NewDefaultRegistry().LookupRequest(protocol)
			if !ok {
				t.Fatalf("missing encoder %s", protocol)
			}
			_, _ = encoder.Encode(context.Background(), req)
		}
	})
}

func FuzzTask22SidecarMergeNoPanic(f *testing.F) {
	f.Add([]byte(`{"model":"fixture-model","messages":[{"role":"user","content":"fixture"}],"metadata":{"fixture":true}}`), []byte(`{"model":"fixture-model","messages":[{"role":"user","content":"fixture"}]}`))
	f.Add([]byte(`{}`), []byte(`{}`))
	f.Fuzz(func(t *testing.T, original, encoded []byte) {
		if len(original) > 64*1024 {
			original = original[:64*1024]
		}
		if len(encoded) > 64*1024 {
			encoded = encoded[:64*1024]
		}
		var wire map[string]any
		if json.Unmarshal(encoded, &wire) != nil {
			wire = map[string]any{}
		}
		for _, protocol := range []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini} {
			sidecar, err := CaptureNativeSidecar(protocol, original, wire)
			if err != nil {
				continue
			}
			_, _ = sidecar.ApplySameSurface(protocol, wire)
		}
	})
}

func FuzzTask22ToolArgumentsAndMediaNoPanic(f *testing.F) {
	f.Add([]byte(`{"q":"fixture"}`), uint8(1), uint8(1))
	f.Add([]byte("not-json"), uint8(4), uint8(2))
	f.Fuzz(func(t *testing.T, raw []byte, mediaKind uint8, referenceKind uint8) {
		if len(raw) > MaxToolArgumentBytes {
			raw = raw[:MaxToolArgumentBytes]
		}
		_ = RepairToolCallArguments(string(raw))
		kind := MediaKind(mediaKind % 6)
		ref := ReferenceKind(referenceKind % 5)
		value := string(raw)
		if len(value) > MaxMediaURLLength {
			value = value[:MaxMediaURLLength]
		}
		_, _ = NewMediaReference(kind, ref, value, MediaReferenceOptions{MIMEType: "application/octet-stream", Detail: ImageDetailAuto})
		req := &NormalizedRequest{Model: "fixture-model", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolName: "fixture", ToolArguments: string(raw)}}}}}
		_, _, _ = NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	})
}

func FuzzTask22ResponseDecodersAndSanitizersNoPanic(f *testing.F) {
	f.Add(uint8(0), []byte(`{"id":"fixture-response","object":"chat.completion","model":"fixture-model","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
	f.Add(uint8(1), []byte(`{"id":"fixture-response","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}`))
	f.Add(uint8(2), []byte(`{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}`))
	f.Add(uint8(3), []byte(`{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}`))
	f.Fuzz(func(t *testing.T, surface uint8, body []byte) {
		if len(body) > 64*1024 {
			body = body[:64*1024]
		}
		protocols := []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini}
		registry := NewDefaultRegistry()
		decoder, ok := registry.LookupResponseDecoder(protocols[int(surface)%len(protocols)])
		if !ok {
			t.Fatal("response decoder missing")
		}
		response, err := decoder.Decode(context.Background(), body, "fixture-model")
		if err != nil || response == nil {
			return
		}
		encoder, ok := registry.LookupResponse(decoder.Protocol())
		if !ok {
			return
		}
		wire, err := encoder.Encode(context.Background(), response)
		if err != nil || wire == nil {
			return
		}
		encoded, marshalErr := json.Marshal(wire)
		if marshalErr != nil || len(encoded) > 8*len(body)+64*1024 {
			t.Fatalf("response expansion is unbounded")
		}
	})
}

func FuzzTask22TerminalStateNoPanic(f *testing.F) {
	f.Add("response_completed", uint8(0), true)
	f.Add("response.failed", uint8(1), false)
	f.Fuzz(func(t *testing.T, eventType string, status uint8, hasUsage bool) {
		if len(eventType) > 128 {
			eventType = eventType[:128]
		}
		event := &NormalizedEvent{Type: eventType, Status: ItemStatus(status % 6)}
		if hasUsage {
			event.Usage = &Usage{InputTokens: 1, OutputTokens: 2, TotalTokens: 3}
		}
		for _, encoder := range []ResponseEncoder{NewOpenAIChatResponseEncoder(), NewOpenAIResponsesResponseEncoder(), NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
			_, _ = encoder.EncodeEvent(context.Background(), event)
		}
	})
}
