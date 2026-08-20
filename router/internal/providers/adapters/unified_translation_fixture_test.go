package adapters

import (
	"context"
	"testing"

	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

func TestAnthropicStreamToolArgumentsAccumulateExactlyOnceAcrossLifecycle(t *testing.T) {
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("claude", "Claude", nil)}})
	decoder := adapter.NewStreamDecoder()
	start, err := decoder.Decode(context.Background(), []byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\n\n"))
	if err != nil || len(start) != 1 || start[0].Type != "tool_call_start" || start[0].ToolCallID != "toolu_1" {
		t.Fatalf("tool start = %#v, %v", start, err)
	}
	first, err := decoder.Decode(context.Background(), []byte(`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"q\":\""}}`))
	if err != nil || len(first) != 1 || first[0].Type != "tool_call_delta" || first[0].ToolArguments != `{"q":"` {
		t.Fatalf("first argument delta = %#v, %v", first, err)
	}
	second, err := decoder.Decode(context.Background(), []byte(`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x\"}"}}`))
	if err != nil || len(second) != 1 || second[0].Type != "tool_call_delta" || second[0].ToolArguments != `x"}` {
		t.Fatalf("second argument delta = %#v, %v", second, err)
	}
	end, err := decoder.Decode(context.Background(), []byte("data: {\"type\":\"content_block_stop\",\"index\":0}"))
	if err != nil || len(end) != 1 || end[0].Type != "tool_call_end" || end[0].ToolCallID != "toolu_1" {
		t.Fatalf("tool end = %#v, %v", end, err)
	}

	var args string
	for _, event := range append(append(start, first...), append(second, end...)...) {
		if event.Type == "tool_call_delta" {
			args += event.ToolArguments
		}
	}
	if got, want := transforms.RepairToolCallArguments(args), `{"q":"x"}`; got != want {
		t.Fatalf("accumulated arguments = %q, want %q", got, want)
	}
}
