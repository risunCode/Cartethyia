package codec

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestRequestDecodersRoundTripSupportedSurfaces(t *testing.T) {
	tests := []struct {
		name    string
		decoder RequestDecoder
		encoder RequestEncoder
		body    string
		model   string
		field   string
	}{
		{
			name:    "openai chat",
			decoder: NewOpenAIChatRequestDecoder(),
			encoder: NewOpenAIChatCodec(),
			body:    `{"model":"gpt-5","stream":true,"messages":[{"role":"user","content":"hello"}]}`,
			model:   "gpt-5",
			field:   "messages",
		},
		{
			name:    "openai responses",
			decoder: NewOpenAIResponsesRequestDecoder(),
			encoder: NewOpenAIResponsesCodec(),
			body:    `{"model":"gpt-5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`,
			model:   "gpt-5",
			field:   "input",
		},
		{
			name:    "anthropic messages",
			decoder: NewAnthropicMessagesRequestDecoder(),
			encoder: NewAnthropicMessagesCodec(),
			body:    `{"model":"claude-sonnet-4","max_tokens":128,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`,
			model:   "claude-sonnet-4",
			field:   "messages",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, decodeErr := tc.decoder.Decode(context.Background(), []byte(tc.body), true)
			if decodeErr != nil {
				t.Fatalf("Decode: %v", decodeErr)
			}
			if req.Model != tc.model || !req.Stream {
				t.Fatalf("normalized request = %#v", req)
			}
			result, encodeErr := tc.encoder.Encode(context.Background(), req)
			if encodeErr != nil {
				t.Fatalf("Encode: %v", encodeErr)
			}
			if got, ok := result.Wire["model"].(string); !ok || got != tc.model {
				t.Fatalf("encoded model = %#v", result.Wire["model"])
			}
			if _, ok := result.Wire[tc.field]; !ok {
				t.Fatalf("encoded payload missing %q: %#v", tc.field, result.Wire)
			}
		})
	}
}

func TestNormalizeRequestChangedBodyOwnsMergedBytes(t *testing.T) {
	body := []byte(`{"model":"fixture-model","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:IMAGE/PNG;base64,YQ=="}}]}]}`)
	prepared, terr := NormalizeRequest(context.Background(), contracts.ProtocolOpenAIChat, body, false)
	if terr != nil {
		t.Fatal(terr)
	}
	if !prepared.Changed || len(prepared.Body) == 0 {
		t.Fatalf("normalization did not exercise changed body path: changed=%v body=%d", prepared.Changed, len(prepared.Body))
	}
	want := append([]byte(nil), prepared.Body...)
	body[0] = '!'
	body[len(body)-1] = '!'
	if string(prepared.Body) != string(want) {
		t.Fatal("prepared body changed after caller buffer mutation")
	}
}

func TestOpenAIChatTypedCodecRetainsUnknownContentBlock(t *testing.T) {
	body := []byte(`{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"vendor_block","payload":{"keep":true}}]}]}`)
	request, terr := NewOpenAIChatRequestDecoder().Decode(context.Background(), body, false)
	if terr != nil {
		t.Fatal(terr)
	}
	if len(request.Messages) != 1 || len(request.Messages[0].Content) != 1 || request.Messages[0].Content[0].Type != BlockNative {
		t.Fatalf("decoded unknown content = %#v", request.Messages)
	}
	encoded, terr := NewOpenAIChatCodec().Encode(context.Background(), request)
	if terr != nil {
		t.Fatal(terr)
	}
	messages, ok := encoded.Wire["messages"].([]map[string]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("encoded messages = %#v", encoded.Wire["messages"])
	}
	content, ok := messages[0]["content"].([]map[string]any)
	if !ok || len(content) != 1 || content[0]["type"] != "vendor_block" {
		t.Fatalf("encoded unknown content = %#v", messages[0]["content"])
	}
	payload, ok := content[0]["payload"].(map[string]any)
	if !ok || payload["keep"] != true {
		t.Fatalf("encoded unknown payload = %#v", content[0])
	}
}

func TestNormalizedRequestValidateRejectsSemanticBounds(t *testing.T) {
	tooLong := strings.Repeat("x", MaxTextBlockLength+1)
	req := &NormalizedRequest{
		Model:  "gpt-5",
		Source: contracts.ProtocolOpenAIChat,
		Messages: []NormalizedMessage{{
			Role:    RoleUser,
			Content: []ContentBlock{{Type: BlockText, Text: tooLong}},
		}},
	}
	if err := req.Validate(); err == nil {
		t.Fatal("expected oversized canonical text to be rejected")
	}

	badTemperature := 3.0
	req = &NormalizedRequest{
		Model:       "gpt-5",
		Source:      contracts.ProtocolOpenAIChat,
		Temperature: &badTemperature,
	}
	if err := req.Validate(); err == nil {
		t.Fatal("expected invalid temperature to be rejected")
	}
}

func TestDecoderRejectsTooManyCanonicalTools(t *testing.T) {
	tools := make([]map[string]any, MaxToolCount+1)
	for i := range tools {
		tools[i] = map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        "tool_" + string(rune('a'+i%26)),
				"description": "bounded",
				"parameters":  map[string]any{"type": "object"},
			},
		}
	}
	body, err := json.Marshal(map[string]any{
		"model":    "gpt-5",
		"messages": []map[string]any{{"role": "user", "content": "hello"}},
		"tools":    tools,
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if _, decodeErr := NewOpenAIChatRequestDecoder().Decode(context.Background(), body, false); decodeErr == nil {
		t.Fatal("expected too many tools to be rejected")
	}
}
