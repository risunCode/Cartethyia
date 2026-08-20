package router

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/providers"
)

func TestRepairStateRejectsUnchangedRepeatedAndPerRuleBodies(t *testing.T) {
	initial := []byte(`{"input":"prompt-SENTINEL","encrypted_content":"cipher"}`)
	var evidence []RepairEvidence
	state := NewRepairState(initial, 4, func(item RepairEvidence) { evidence = append(evidence, item) })

	if body, item, ok := state.Apply("grok-build", 1, initial, providers.RepairProposal{RuleID: "grok.invalid_encrypted_reasoning", Body: append([]byte(nil), initial...)}); ok || body != nil || item.Changed {
		t.Fatalf("unchanged proposal accepted: body=%q evidence=%#v", body, item)
	}

	first := []byte(`{"input":"prompt-SENTINEL"}`)
	if body, item, ok := state.Apply("grok-build", 1, initial, providers.RepairProposal{RuleID: "grok.invalid_encrypted_reasoning", Body: first}); !ok || string(body) != string(first) || !item.Changed {
		t.Fatalf("first proposal rejected: body=%q evidence=%#v ok=%v", body, item, ok)
	}

	second := []byte(`{"input":"prompt-SENTINEL","other":true}`)
	if body, _, ok := state.Apply("grok-build", 2, first, providers.RepairProposal{RuleID: "grok.invalid_encrypted_reasoning", Body: second}); ok || body != nil {
		t.Fatalf("per-rule cap accepted second body: %q", body)
	}

	if body, _, ok := state.Apply("grok-build", 2, first, providers.RepairProposal{RuleID: "grok.second_rule", Body: initial}); ok || body != nil {
		t.Fatalf("previously attempted initial body accepted: %q", body)
	}
	if got := len(evidence); got != 4 {
		t.Fatalf("evidence count=%d, want 4", got)
	}
}

func TestRepairStateEnforcesRequestWideCapAndBoundsEvidence(t *testing.T) {
	initial := []byte(`{"prompt":"user-SENTINEL","tool_result":"tool-SENTINEL"}`)
	var evidence []RepairEvidence
	state := NewRepairState(initial, 1, func(item RepairEvidence) { evidence = append(evidence, item) })
	first := []byte(`{"prompt":"user-SENTINEL"}`)
	if _, _, ok := state.Apply("grok-build", 1, initial, providers.RepairProposal{RuleID: "grok.rule_one", Body: first}); !ok {
		t.Fatal("first request-wide repair rejected")
	}
	if body, _, ok := state.Apply("grok-build", 2, first, providers.RepairProposal{RuleID: "grok.rule_two", Body: []byte(`{}`)}); ok || body != nil {
		t.Fatalf("request-wide cap accepted second rule: %q", body)
	}
	want := []RepairEvidence{
		{Provider: "grok-build", RuleID: "grok.rule_one", Attempt: 1, Changed: true},
		{Provider: "grok-build", RuleID: "grok.rule_two", Attempt: 2, Changed: true},
	}
	if !reflect.DeepEqual(evidence, want) {
		t.Fatalf("evidence=%#v, want %#v", evidence, want)
	}
	serialized := fmt.Sprint(evidence)
	bodyHash := sha256.Sum256(initial)
	for _, secret := range []string{"user-SENTINEL", "tool-SENTINEL", "encrypted_content", hex.EncodeToString(bodyHash[:])} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("repair evidence exposed %q: %s", secret, serialized)
		}
	}
}

func TestRepairStateNonPositiveLimitUsesConservativeDefault(t *testing.T) {
	for _, limit := range []int{0, -2} {
		state := NewRepairState([]byte(`{"value":0}`), limit, nil)
		first, _, accepted := state.Apply("grok-build", 1, []byte(`{"value":0}`), providers.RepairProposal{RuleID: "grok.rule_one", Body: []byte(`{"value":1}`)})
		if !accepted {
			t.Fatalf("limit %d rejected first repair", limit)
		}
		if body, _, accepted := state.Apply("grok-build", 2, first, providers.RepairProposal{RuleID: "grok.rule_two", Body: []byte(`{"value":2}`)}); accepted || body != nil {
			t.Fatalf("limit %d did not apply conservative request-wide cap: %q", limit, body)
		}
	}
}

func TestRepairRuleErrorCarriesOnlyStableRule(t *testing.T) {
	cause := errors.New("provider rejected request")
	wrapped := WithRepairRule(cause, "grok.invalid_encrypted_reasoning")
	if rule, ok := RepairRuleFrom(wrapped); !ok || rule != "grok.invalid_encrypted_reasoning" {
		t.Fatalf("rule=%q ok=%v", rule, ok)
	}
	if wrapped.Error() != cause.Error() {
		t.Fatalf("wrapped error changed safe cause: %q", wrapped.Error())
	}
	if got := WithRepairRule(cause, "invalid/user-SENTINEL/path"); got != cause {
		t.Fatalf("unsafe rule was attached: %v", got)
	}
}
