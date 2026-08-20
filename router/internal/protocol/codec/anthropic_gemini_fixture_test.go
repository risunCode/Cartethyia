package codec

import (
	"context"
	"encoding/json"
	"testing"
)

func TestAnthropicResponseFixtureEncodesToolArgumentsAsObject(t *testing.T) {
	payload, terr := NewAnthropicMessagesResponseEncoder().Encode(context.Background(), &NormalizedResponse{
		ID: "msg_fixture", Model: "claude-fixture",
		ToolCalls: []NormalizedToolCall{{ID: "call_fixture", Name: "lookup", Arguments: `{"q":"x"}`}},
	})
	if terr != nil {
		t.Fatal(terr)
	}
	wire, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(wire, &body); err != nil {
		t.Fatal(err)
	}
	content := body["content"].([]any)
	input := content[0].(map[string]any)["input"].(map[string]any)
	if input["q"] != "x" {
		t.Fatalf("tool input=%#v", input)
	}
}

func TestGeminiResponseFixtureEncodesToolArgumentsAsObject(t *testing.T) {
	payload, terr := NewGeminiResponseEncoder().Encode(context.Background(), &NormalizedResponse{
		Model: "gemini-fixture",
		ToolCalls: []NormalizedToolCall{{ID: "call_fixture", Name: "lookup", Arguments: `{"q":"x"}`}},
	})
	if terr != nil {
		t.Fatal(terr)
	}
	wire, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(wire, &body); err != nil {
		t.Fatal(err)
	}
	candidate := body["candidates"].([]any)[0].(map[string]any)
	parts := candidate["content"].(map[string]any)["parts"].([]any)
	call := parts[0].(map[string]any)["functionCall"].(map[string]any)
	if call["args"].(map[string]any)["q"] != "x" {
		t.Fatalf("function args=%#v", call["args"])
	}
}

func TestAnthropicAndGeminiStreamFixturesDecodeToolAndMediaEvents(t *testing.T) {
	anthropic := NewAnthropicMessagesResponseDecoder()
	toolStart, terr := anthropic.DecodeEvent(context.Background(), []byte(`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"lookup","input":{}}}`))
	if terr != nil || toolStart == nil || toolStart.Type != EventToolCallDelta || toolStart.ToolCallID != "call_1" {
		t.Fatalf("anthropic tool start=%#v err=%v", toolStart, terr)
	}
	media, terr := anthropic.DecodeEvent(context.Background(), []byte(`{"type":"content_block_start","index":2,"content_block":{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aA=="}}}`))
	if terr != nil || media == nil || media.Media == nil || media.Media.Value != "aA==" {
		t.Fatalf("anthropic media=%#v err=%v", media, terr)
	}

	gemini := NewGeminiResponseDecoder()
	tool, terr := gemini.DecodeEvent(context.Background(), []byte(`{"candidates":[{"index":1,"content":{"parts":[{"functionCall":{"id":"call_1","name":"lookup","args":{"q":"x"}}}]}}]}`))
	if terr != nil || tool == nil || tool.Type != EventToolCallDelta || tool.ToolName != "lookup" {
		t.Fatalf("gemini tool=%#v err=%v", tool, terr)
	}
	geminiMedia, terr := gemini.DecodeEvent(context.Background(), []byte(`{"candidates":[{"index":2,"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"aA=="}}]}}]}`))
	if terr != nil || geminiMedia == nil || geminiMedia.Media == nil || geminiMedia.Media.Value != "aA==" {
		t.Fatalf("gemini media=%#v err=%v", geminiMedia, terr)
	}
}

func TestAnthropicAndGeminiStreamFixturesRejectUnsupportedEvents(t *testing.T) {
	for _, encoder := range []ResponseEncoder{NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
		if _, terr := encoder.EncodeEvent(context.Background(), &NormalizedEvent{Type: EventRefusalDelta, Text: "no"}); terr == nil || terr.Code != CodeUnsupportedFeature {
			t.Fatalf("encoder=%T unsupported error=%v", encoder, terr)
		}
	}
}

func TestAnthropicAndGeminiResponseFixturesRejectInvalidToolArguments(t *testing.T) {
	for _, encoder := range []ResponseEncoder{NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
		_, terr := encoder.Encode(context.Background(), &NormalizedResponse{
			Model:     "fixture-model",
			ToolCalls: []NormalizedToolCall{{Name: "lookup", Arguments: `{"unterminated"`}},
		})
		if terr == nil || terr.Code != CodeInvalidRequest {
			t.Fatalf("encoder=%T invalid args error=%v", encoder, terr)
		}
	}
}
