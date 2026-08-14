package transforms

import (
	"context"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestCanonicalToolCallsPreserveIDsArgumentsAndImmediateAdjacency(t *testing.T) {
	body := []byte(`{
		"model":"gpt-test",
		"parallel_tool_calls":true,
		"messages":[
			{"role":"user","content":"look up both"},
			{"role":"assistant","content":null,"tool_calls":[
				{"id":"call_a","type":"function","function":{"name":"lookup","arguments":" { \"q\": \"x\" } "}},
				{"id":"call_b","type":"function","function":{"name":"lookup","arguments":""}}
			]},
			{"role":"tool","tool_call_id":"call_a","content":"result-a"},
			{"role":"tool","tool_call_id":"call_b","content":"result-b"}
		],
		"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]
	}`)
	request, decodeErr := NewOpenAIChatRequestDecoder().Decode(context.Background(), body, false)
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if request.ParallelToolCalls == nil || !*request.ParallelToolCalls {
		t.Fatal("parallel tool intent was not retained")
	}
	if len(request.Messages) != 4 || len(request.Messages[1].Content) != 2 {
		t.Fatalf("canonical messages = %#v", request.Messages)
	}
	calls := request.Messages[1].Content
	if calls[0].ToolCallID != "call_a" || calls[0].ToolArguments != `{"q":"x"}` {
		t.Fatalf("first call = %#v", calls[0])
	}
	if calls[1].ToolCallID != "call_b" || calls[1].ToolArguments != "{}" {
		t.Fatalf("empty second call = %#v", calls[1])
	}
	if request.Messages[2].Content[0].ToolCallID != "call_a" || request.Messages[3].Content[0].ToolCallID != "call_b" {
		t.Fatal("tool results lost call association or order")
	}

	responses, encodeErr := NewOpenAIResponsesCodec().Encode(context.Background(), request)
	if encodeErr != nil {
		t.Fatal(encodeErr)
	}
	items, ok := responses.Wire["input"].([]map[string]any)
	if !ok {
		t.Fatalf("responses input type = %T", responses.Wire["input"])
	}
	if len(items) != 6 {
		t.Fatalf("responses input length = %d, want user + assistant + 2 calls + 2 outputs", len(items))
	}
	wantTypes := []string{"user", "assistant", "function_call", "function_call", "function_call_output", "function_call_output"}
	for i, want := range wantTypes {
		if got, _ := items[i]["role"].(string); got == want {
			continue
		}
		if got, _ := items[i]["type"].(string); got != want {
			t.Fatalf("responses item %d = %#v, want %q", i, items[i], want)
		}
	}
	if items[2]["call_id"] != "call_a" || items[3]["call_id"] != "call_b" || items[4]["call_id"] != "call_a" || items[5]["call_id"] != "call_b" {
		t.Fatalf("responses call adjacency/order = %#v", items)
	}
	if items[3]["arguments"] != "{}" {
		t.Fatalf("empty arguments changed during Responses encoding: %#v", items[3]["arguments"])
	}

	anthropic, encodeErr := NewAnthropicMessagesCodec().Encode(context.Background(), request)
	if encodeErr != nil {
		t.Fatal(encodeErr)
	}
	messages, ok := anthropic.Wire["messages"].([]map[string]any)
	if !ok || len(messages) != 4 {
		t.Fatalf("Anthropic messages = %#v", anthropic.Wire["messages"])
	}
	assistantBlocks, _ := messages[1]["content"].([]map[string]any)
	if len(assistantBlocks) != 2 || assistantBlocks[0]["id"] != "call_a" || assistantBlocks[1]["id"] != "call_b" {
		t.Fatalf("Anthropic tool-use blocks = %#v", assistantBlocks)
	}
	firstResult, _ := messages[2]["content"].([]map[string]any)
	secondResult, _ := messages[3]["content"].([]map[string]any)
	if len(firstResult) != 1 || len(secondResult) != 1 || firstResult[0]["tool_use_id"] != "call_a" || secondResult[0]["tool_use_id"] != "call_b" {
		t.Fatalf("Anthropic tool-result blocks = %#v/%#v", firstResult, secondResult)
	}
}
func TestAnthropicDecoderRetainsToolUseAndResultAssociation(t *testing.T) {
	body := []byte(`{
		"model":"claude-test",
		"max_tokens":64,
		"messages":[
			{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"result"}]}
		]
	}`)
	request, decodeErr := NewAnthropicMessagesRequestDecoder().Decode(context.Background(), body, false)
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if len(request.Messages) != 2 || request.Messages[0].Role != RoleAssistant || request.Messages[1].Role != RoleTool {
		t.Fatalf("Anthropic canonical messages = %#v", request.Messages)
	}
	if len(request.Messages[0].Content) != 1 || request.Messages[0].Content[0].ToolCallID != "toolu_1" || request.Messages[0].Content[0].ToolArguments != `{"q":"x"}` {
		t.Fatalf("Anthropic tool-use = %#v", request.Messages[0].Content)
	}
	if len(request.Messages[1].Content) != 1 || request.Messages[1].Content[0].ToolCallID != "toolu_1" || request.Messages[1].Content[0].Text != "result" {
		t.Fatalf("Anthropic tool-result = %#v", request.Messages[1].Content)
	}
}

func TestResponsesReasoningRoundTripKeepsEncryptedContextOutOfVisibleText(t *testing.T) {
	body := []byte(`{
		"model":"gpt-reasoning",
		"input":[
			{"type":"reasoning","id":"rs_1","encrypted_content":"opaque-reasoning","summary":[{"type":"summary_text","text":"private plan"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}
		],
		"reasoning":{"effort":"high","summary":"detailed"}
	}`)
	request, decodeErr := NewOpenAIResponsesRequestDecoder().Decode(context.Background(), body, false)
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if request.Reasoning != ReasoningEnabled || request.ReasoningConfig == nil || request.ReasoningConfig.Effort != EffortHigh {
		t.Fatalf("reasoning config = %#v flag=%q", request.ReasoningConfig, request.Reasoning)
	}
	if len(request.Messages) != 1 || len(request.Messages[0].ReasoningItemsBefore) != 1 {
		t.Fatalf("reasoning context = %#v", request.Messages)
	}
	if request.Messages[0].ReasoningItemsBefore[0]["encrypted_content"] != "opaque-reasoning" {
		t.Fatalf("encrypted reasoning was not retained: %#v", request.Messages[0].ReasoningItemsBefore)
	}
	encoded, encodeErr := NewOpenAIResponsesCodec().Encode(context.Background(), request)
	if encodeErr != nil {
		t.Fatal(encodeErr)
	}
	items, ok := encoded.Wire["input"].([]map[string]any)
	if !ok || len(items) != 2 || items[0]["type"] != "reasoning" {
		t.Fatalf("encoded reasoning items = %#v", encoded.Wire["input"])
	}
	if items[0]["encrypted_content"] != "opaque-reasoning" {
		t.Fatalf("encrypted reasoning changed: %#v", items[0])
	}
	assistant, _ := items[1]["content"].([]map[string]any)
	if len(assistant) != 1 || assistant[0]["text"] != "answer" {
		t.Fatalf("visible assistant content = %#v", assistant)
	}
	for _, field := range assistant {
		if text, _ := field["text"].(string); strings.Contains(text, "opaque-reasoning") {
			t.Fatal("encrypted reasoning synthesized into visible assistant text")
		}
	}
}

func TestAnthropicReasoningAndToolArgumentsAreDistinctCanonicalBlocks(t *testing.T) {
	req := &NormalizedRequest{
		Model:  "claude-test",
		Source: contracts.ProtocolAnthropic,
		Messages: []NormalizedMessage{
			{Role: RoleUser, Content: []ContentBlock{{Type: BlockText, Text: "run"}}},
			{Role: RoleAssistant, Content: []ContentBlock{
				{Type: BlockReasoning, ReasoningText: "private thought", ReasoningSignature: "sig-1"},
				{Type: BlockToolUse, ToolCallID: "toolu_1", ToolName: "lookup", ToolArguments: `{"q":"x"}`},
			}},
		},
		Reasoning:       ReasoningEnabled,
		ReasoningConfig: &ReasoningConfig{MaxTokens: 64, Enabled: true},
	}
	encoded, encodeErr := NewAnthropicMessagesCodec().Encode(context.Background(), req)
	if encodeErr != nil {
		t.Fatal(encodeErr)
	}
	messages, _ := encoded.Wire["messages"].([]map[string]any)
	blocks, _ := messages[1]["content"].([]map[string]any)
	if len(blocks) != 2 || blocks[0]["type"] != "thinking" || blocks[0]["thinking"] != "private thought" {
		t.Fatalf("reasoning block = %#v", blocks)
	}
	if blocks[1]["type"] != "tool_use" || blocks[1]["id"] != "toolu_1" {
		t.Fatalf("tool block = %#v", blocks[1])
	}
	if blocks[1]["input"] == "private thought" {
		t.Fatal("reasoning was synthesized as tool input")
	}
}

func TestTransformErrorsDoNotEchoSecretBody(t *testing.T) {
	secret := "access-token=fixture-secret-123"
	_, err := NewOpenAIChatRequestDecoder().Decode(context.Background(), []byte(`{"model":"gpt","messages":[`+secret), false)
	if err == nil {
		t.Fatal("malformed request unexpectedly decoded")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("transform error leaked request body: %v", err)
	}
}

func stringMustString(v any) string {
	s, _ := v.(string)
	return s
}
