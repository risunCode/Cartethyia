package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

func TestAnthropicBuildRequestCanonicalToolsReasoningAndIdentity(t *testing.T) {
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("client-model", "Client", nil)}})
	target, err := adapter.ResolveTarget("client-model", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"model":"client-model","max_tokens":128,"thinking":{"type":"enabled","budget_tokens":64},"system":"be concise","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"tools":[{"name":"lookup","description":"look up","input_schema":{"type":"object"}}]}`)
	built, err := adapter.BuildRequest(RequestEnvelope{Target: target, Body: body, Stream: true}, "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	if built.Endpoint.Path != "messages" || built.Endpoint.Method != "POST" || !built.Stream {
		t.Fatalf("built request endpoint/stream = %#v/%v", built.Endpoint, built.Stream)
	}
	if got := built.Auth.Headers.Get("x-api-key"); got != "secret-value" {
		t.Fatalf("x-api-key = %q", got)
	}
	if got := built.Auth.Headers.Get("accept"); got != "text/event-stream" {
		t.Fatalf("accept = %q", got)
	}
	if strings.Contains(string(built.Body), "secret-value") {
		t.Fatal("credential leaked into request body")
	}
	var wire map[string]any
	if err := json.Unmarshal(built.Body, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["model"] != "client-model" || wire["stream"] != true {
		t.Fatalf("wire identity/stream = %#v/%v", wire["model"], wire["stream"])
	}
	if _, ok := wire["thinking"]; !ok {
		t.Fatal("thinking block was not encoded")
	}
	if _, ok := wire["tools"]; !ok {
		t.Fatal("tools were not encoded")
	}
}

func TestAnthropicBuildRequestRejectsUnsupportedCapabilityBeforeUpstream(t *testing.T) {
	caps := ProviderCaps{Surfaces: []Surface{SurfaceAnthropicMessages}, Streaming: false, ToolCalls: false, Images: false, Reasoning: false}
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("plain", "Plain", &caps)}})
	target := RouteTarget{ProviderID: "anthropic", ModelID: "plain", UpstreamModelID: "plain", Surface: SurfaceAnthropicMessages}
	_, err := adapter.BuildRequest(RequestEnvelope{Target: target, Stream: true, Body: []byte(`{"model":"plain","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`)}, "secret")
	var coded *AnthropicAdapterError
	if !errors.As(err, &coded) || coded.Code != AnthropicErrorCapabilityUnsupported {
		t.Fatalf("unsupported stream error = %v (%T), code %q", err, err, codedCode(coded))
	}
}

func TestAnthropicDecodeResponseMapsBlocksAndUsage(t *testing.T) {
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("claude", "Claude", nil)}})
	response, err := adapter.DecodeResponse(context.Background(), []byte(`{"id":"msg_1","model":"claude","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"answer"},{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}},{"type":"web_search_tool_result","results":[{"title":"source"}]}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}`), "claude")
	if err != nil {
		t.Fatal(err)
	}
	if response.Text != "answer" || response.StopReason != transforms.StopToolCall || response.Usage == nil {
		t.Fatalf("response summary = %#v", response)
	}
	if response.Usage.InputTokens != 10 || response.Usage.OutputTokens != 7 || response.Usage.CacheRead != 3 || response.Usage.CacheWrite != 2 {
		t.Fatalf("usage = %#v", response.Usage)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].ID != "toolu_1" || response.ToolCalls[0].Arguments != `{"q":"x"}` {
		t.Fatalf("tool calls = %#v", response.ToolCalls)
	}
	if _, err := adapter.DecodeResponse(context.Background(), []byte(`{"model":"claude","content":{}}`), "claude"); err == nil {
		t.Fatal("malformed content returned nil error")
	}
}

func TestAnthropicStreamDecoderMapsToolLifecycleAndErrors(t *testing.T) {
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("claude", "Claude", nil)}})
	decoder := adapter.NewStreamDecoder()
	start, err := decoder.Decode(context.Background(), []byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\n\n"))
	if err != nil || len(start) != 1 || start[0].Type != "tool_call_start" {
		t.Fatalf("tool start = %#v, %v", start, err)
	}
	delta, err := decoder.Decode(context.Background(), []byte("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"q\\\":\\\"x\\\"}\"}}"))
	if err != nil || len(delta) != 1 || delta[0].ToolCallID != "toolu_1" {
		t.Fatalf("tool delta = %#v, %v", delta, err)
	}
	stop, err := decoder.Decode(context.Background(), []byte("data: {\"type\":\"content_block_stop\",\"index\":0}"))
	if err != nil || len(stop) != 1 || stop[0].Type != "tool_call_end" {
		t.Fatalf("tool stop = %#v, %v", stop, err)
	}
	_, err = decoder.Decode(context.Background(), []byte("data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}"))
	var coded *AnthropicAdapterError
	if !errors.As(err, &coded) || coded.Code != AnthropicErrorProviderFailure {
		t.Fatalf("stream error = %v (%T), code %q", err, err, codedCode(coded))
	}
}

func codedCode(err *AnthropicAdapterError) string {
	if err == nil {
		return ""
	}
	return err.Code
}
