package codec

import (
	"context"
	"encoding/json"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestChatResponseDecoderPreservesTextToolAndUsage(t *testing.T) {
	body := []byte(`{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-5","system_fingerprint":"fp_1","choices":[{"index":0,"message":{"role":"assistant","content":"hello","tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":6}}}`)
	response, terr := NewOpenAIChatResponseDecoder().Decode(context.Background(), body, "gpt-5")
	if terr != nil {
		t.Fatal(terr)
	}
	if response.Text != "hello" {
		t.Fatalf("text = %q", response.Text)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d", len(response.ToolCalls))
	}
	if response.ToolCalls[0].Name != "lookup" {
		t.Fatalf("tool name = %q", response.ToolCalls[0].Name)
	}
	if response.Usage == nil || response.Usage.CacheReadTokens != 6 {
		t.Fatalf("usage = %#v", response.Usage)
	}
	if response.StopReason != StopToolCall {
		t.Fatalf("stop = %v", response.StopReason)
	}
}

func TestResponsesResponseDecoderPreservesToolIDAndIndex(t *testing.T) {
	body := []byte(`{"id":"resp_1","object":"response","model":"gpt-5","status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{}"},{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`)
	response, terr := NewOpenAIResponsesResponseDecoder().Decode(context.Background(), body, "gpt-5")
	if terr != nil {
		t.Fatal(terr)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].ItemID != "fc_1" {
		t.Fatalf("tool calls = %#v", response.ToolCalls)
	}
	if response.Text != "ok" {
		t.Fatalf("text = %q", response.Text)
	}
}

func TestAnthropicResponseDecoderPreservesStopReasonAndReasoning(t *testing.T) {
	body := []byte(`{"id":"msg_1","type":"message","model":"claude","role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"think","signature":"sig"},{"type":"text","text":"hello"}],"usage":{"input_tokens":2,"output_tokens":3}}`)
	response, terr := NewAnthropicMessagesResponseDecoder().Decode(context.Background(), body, "claude")
	if terr != nil {
		t.Fatal(terr)
	}
	if response.Text != "hello" {
		t.Fatalf("text = %q", response.Text)
	}
	if response.StopReason != StopCompleted {
		t.Fatalf("stop = %v", response.StopReason)
	}
}

func TestGeminiResponseDecoderPreservesTextAndFunctionCall(t *testing.T) {
	body := []byte(`{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hi"},{"functionCall":{"id":"call_1","name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}`)
	response, terr := NewGeminiResponseDecoder().Decode(context.Background(), body, "gemini")
	if terr != nil {
		t.Fatal(terr)
	}
	if response.Text != "hi" {
		t.Fatalf("text = %q", response.Text)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d", len(response.ToolCalls))
	}
}

func TestChatResponseEncoderEmitsCorrectFinishReason(t *testing.T) {
	stop := StopToolCall
	response := &NormalizedResponse{ID: "id", Model: "gpt-5", Text: "hi", StopReason: stop}
	payload, terr := NewOpenAIChatResponseEncoder().Encode(context.Background(), response)
	if terr != nil {
		t.Fatal(terr)
	}
	choices := payload["choices"].([]any)
	choice := choices[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %v", choice["finish_reason"])
	}
}

func TestResponsesResponseEncoderPreservesOutputItems(t *testing.T) {
	response := &NormalizedResponse{ID: "id", Model: "gpt-5", Text: "ok"}
	payload, terr := NewOpenAIResponsesResponseEncoder().Encode(context.Background(), response)
	if terr != nil {
		t.Fatal(terr)
	}
	output, ok := payload["output"].([]map[string]any)
	if !ok || len(output) == 0 {
		t.Fatalf("output missing: %#v", payload["output"])
	}
	if output[0]["type"] != "message" {
		t.Fatalf("output type = %v", output[0]["type"])
	}
}

func TestOpenAIChatStreamUsageAndTerminalFrames(t *testing.T) {
	decoder := NewOpenAIChatResponseDecoder()
	usage, terr := decoder.DecodeEvent(context.Background(), []byte(`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`))
	if terr != nil {
		t.Fatal(terr)
	}
	if usage == nil || usage.Type != EventUsage || usage.Usage == nil {
		t.Fatalf("usage event = %#v", usage)
	}
	if usage.Usage.TotalTokens != 5 || usage.StopReason == nil || *usage.StopReason != StopCompleted {
		t.Fatalf("usage terminal state = %#v", usage)
	}
	terminal, terr := decoder.DecodeEvent(context.Background(), []byte(`{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`))
	if terr != nil {
		t.Fatal(terr)
	}
	if terminal == nil || terminal.Type != EventResponseCompleted || terminal.StopReason == nil || *terminal.StopReason != StopLength {
		t.Fatalf("terminal event = %#v", terminal)
	}
}

func TestOpenAIResponsesOutputRoundTripPreservesOrderAndUnknown(t *testing.T) {
	body := []byte(`{"id":"resp_1","model":"gpt-5","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{}"},{"type":"vendor_item","id":"native_1","payload":{"keep":true}}]}`)
	response, terr := NewOpenAIResponsesResponseDecoder().Decode(context.Background(), body, "gpt-5")
	if terr != nil {
		t.Fatal(terr)
	}
	if len(response.Output) != 3 || response.Output[0].Type != BlockText || response.Output[1].Type != BlockToolUse || response.Output[2].Type != BlockNative {
		t.Fatalf("decoded output = %#v", response.Output)
	}
	payload, terr := NewOpenAIResponsesResponseEncoder().Encode(context.Background(), response)
	if terr != nil {
		t.Fatal(terr)
	}
	output, ok := payload["output"].([]map[string]any)
	if !ok || len(output) != 3 {
		t.Fatalf("encoded output = %#v", payload["output"])
	}
	if output[0]["type"] != "message" || output[1]["type"] != "function_call" || output[2]["type"] != "vendor_item" {
		t.Fatalf("encoded output order/types = %#v", output)
	}
	native, ok := output[2]["payload"].(map[string]any)
	if !ok || native["keep"] != true {
		t.Fatalf("native output = %#v", output[2])
	}
}

func TestAnthropicResponseEncoderEmitsToolUse(t *testing.T) {
	response := &NormalizedResponse{ID: "id", Model: "claude", ToolCalls: []NormalizedToolCall{{ID: "call_1", Name: "lookup", Arguments: "{\"q\":\"x\"}"}}}
	payload, terr := NewAnthropicMessagesResponseEncoder().Encode(context.Background(), response)
	if terr != nil {
		t.Fatal(terr)
	}
	raw, _ := json.Marshal(payload)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if body["stop_reason"] != "tool_use" {
		t.Fatalf("stop_reason = %v", body["stop_reason"])
	}
}

func TestGeminiResponseEncoderEmitsStop(t *testing.T) {
	response := &NormalizedResponse{Model: "gemini", Text: "hi"}
	payload, terr := NewGeminiResponseEncoder().Encode(context.Background(), response)
	if terr != nil {
		t.Fatal(terr)
	}
	candidates, _ := payload["candidates"].([]any)
	candidate := candidates[0].(map[string]any)
	if candidate["finishReason"] != "STOP" {
		t.Fatalf("finishReason = %v", candidate["finishReason"])
	}
}

func TestRegistryExposesResponseDecoders(t *testing.T) {
	registry := NewDefaultRegistry()
	for _, surface := range []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini} {
		if _, ok := registry.LookupResponseDecoder(surface); !ok {
			t.Fatalf("decoder missing for %s", surface)
		}
		if _, ok := registry.LookupResponse(surface); !ok {
			t.Fatalf("encoder missing for %s", surface)
		}
	}
}
