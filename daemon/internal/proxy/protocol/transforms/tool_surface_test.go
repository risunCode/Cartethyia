package transforms

import (
	"context"
	"testing"
)

func TestResponsesDecoderPreservesAdditionalAndCustomTools(t *testing.T) {
	body := []byte(`{
		"model":"gpt-test",
		"input":[{"type":"additional_tools","tools":[
			{"type":"custom","name":"exec","description":"run command","format":{"type":"text"}},
			{"type":"tool_search","name":"tool_search"}
		]}, {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]
	}`)
	req, err := NewOpenAIResponsesRequestDecoder().Decode(context.Background(), body, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Tools) != 2 {
		t.Fatalf("additional tools were not collected: %#v", req.Tools)
	}
	if req.Tools[0].NativeType != "custom" || req.Tools[0].Name != "exec" || req.Tools[0].NativeOptions["format"] == nil {
		t.Fatalf("custom tool semantics not retained: %#v", req.Tools[0])
	}
	if req.Tools[1].NativeType != "tool_search" {
		t.Fatalf("tool search semantics not retained: %#v", req.Tools[1])
	}
	encoded, encErr := NewOpenAIResponsesCodec().Encode(context.Background(), req)
	if encErr != nil {
		t.Fatal(encErr)
	}
	tools, ok := encoded.Wire["tools"].([]map[string]any)
	if !ok || len(tools) != 2 || tools[0]["type"] != "custom" || tools[1]["type"] != "tool_search" {
		t.Fatalf("custom/native tools were not encoded explicitly: %#v", encoded.Wire["tools"])
	}
}
