package adapters

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestGrokEncryptedReasoningRepairMutationDiff(t *testing.T) {
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build"})
	original := []byte(`{
		"input":[
			{"type":"reasoning","id":"reasoning-1","encrypted_content":"cipher-SENTINEL","summary":[{"type":"summary_text","text":"summary-SENTINEL"}]},
			{"type":"compaction","encrypted_content":"compact-cipher-SENTINEL","summary":"compact-summary-SENTINEL"},
			{"type":"message","role":"user","content":[
				{"type":"input_text","text":"prompt-SENTINEL"},
				{"type":"input_image","image_url":"data:image/png;base64,image-SENTINEL","detail":"high"},
				{"type":"tool_result","tool_call_id":"call-SENTINEL","output":{"encrypted_content":"user-value-SENTINEL","answer":9007199254740993}}
			]},
			{"type":"function_call_output","call_id":"call-SENTINEL","output":"tool-output-SENTINEL"}
		],
		"metadata":{"tenant_note":"metadata-SENTINEL"},
		"tools":[{"type":"function","name":"tool-SENTINEL","description":"description-SENTINEL"}]
	}`)

	proposal, ok := adapter.ProposeRepair(GrokRepairInvalidEncryptedReasoning, RequestEnvelope{
		Target: RouteTarget{ProviderID: "grok-build"},
		Body:   original,
	})
	if !ok {
		t.Fatal("Grok encrypted-reasoning repair was not proposed")
	}
	if proposal.RuleID != GrokRepairInvalidEncryptedReasoning {
		t.Fatalf("rule ID = %q", proposal.RuleID)
	}

	before := decodeRepairJSON(t, original)
	after := decodeRepairJSON(t, proposal.Body)
	beforeInput := before["input"].([]any)
	afterInput := after["input"].([]any)
	for _, index := range []int{2, 3} {
		if got, want := canonicalRepairJSON(t, afterInput[index]), canonicalRepairJSON(t, beforeInput[index]); !bytes.Equal(got, want) {
			t.Fatalf("user-authored input[%d] changed:\n got %s\nwant %s", index, got, want)
		}
	}
	for _, field := range []string{"metadata", "tools"} {
		if !reflect.DeepEqual(after[field], before[field]) {
			t.Fatalf("user-authored %s changed: got %#v want %#v", field, after[field], before[field])
		}
	}

	for _, index := range []int{0, 1} {
		block := beforeInput[index].(map[string]any)
		delete(block, "encrypted_content")
	}
	want := canonicalRepairJSON(t, before)
	if !bytes.Equal(proposal.Body, want) {
		t.Fatalf("repair changed fields outside the allowlist:\n got %s\nwant %s", proposal.Body, want)
	}
}

func TestGrokEncryptedReasoningRepairRuleAndNoChange(t *testing.T) {
	adapter := NewGrokBuildAdapter(GrokBuildConfig{ID: "grok-build"})
	for _, body := range [][]byte{
		[]byte(`{"error":{"code":"invalid_encrypted_content"}}`),
		[]byte(`{"error":{"message":"encrypted_content must remain unmodified"}}`),
	} {
		if rule := adapter.RepairRule(NewResponseEvidence(400, nil, body)); rule != GrokRepairInvalidEncryptedReasoning {
			t.Fatalf("repair rule = %q", rule)
		}
	}
	if rule := adapter.RepairRule(NewResponseEvidence(400, nil, []byte(`{"error":{"code":"invalid_request"}}`))); rule != "" {
		t.Fatalf("generic invalid request unexpectedly matched repair rule %q", rule)
	}

	unchanged := []byte(`{"input":[{"type":"message","role":"user","content":"encrypted_content user text"}]}`)
	if proposal, ok := adapter.ProposeRepair(GrokRepairInvalidEncryptedReasoning, RequestEnvelope{Body: unchanged}); !ok || proposal.RuleID != GrokRepairInvalidEncryptedReasoning || !bytes.Equal(proposal.Body, unchanged) {
		t.Fatalf("unchanged proposal was not surfaced for runtime rejection: %#v ok=%v", proposal, ok)
	}
	if proposal, ok := adapter.ProposeRepair("openai.delete_rejected_field", RequestEnvelope{Body: []byte(`{"input":[{"type":"reasoning","encrypted_content":"cipher"}]}`)}); ok || proposal.RuleID != "" || len(proposal.Body) != 0 {
		t.Fatalf("unknown rule produced proposal: %#v", proposal)
	}
}

func decodeRepairJSON(t *testing.T, body []byte) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode repair JSON: %v", err)
	}
	return value
}

func canonicalRepairJSON(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("canonical repair JSON: %v", err)
	}
	return body
}
