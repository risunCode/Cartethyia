package transforms

import (
	"fmt"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestTask6GeneratedIDsArePositionStableAndCollisionChecked(t *testing.T) {
	request := &NormalizedRequest{
		Model: "fixture", Source: contracts.ProtocolOpenAIChat,
		Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{
			{Type: BlockToolUse, ToolName: "lookup!", ToolCallID: "call_lookup_m0_b0", ToolArguments: "{}"},
			{Type: BlockToolUse, ToolName: "lookup!", ToolArguments: "{}"},
			{Type: BlockToolUse, ToolName: "lookup!", ToolArguments: "{}"},
		}}},
	}
	first, report, err := NormalizeToolCallInvariants(request, ToolCallInvariantPreserve)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := NormalizeToolCallInvariants(request, ToolCallInvariantPreserve)
	if err != nil {
		t.Fatal(err)
	}
	if report.GeneratedCallIDs != 2 {
		t.Fatalf("generated IDs = %d", report.GeneratedCallIDs)
	}
	for i := 1; i < 3; i++ {
		got := first.Messages[0].Content[i].ToolCallID
		if got == first.Messages[0].Content[0].ToolCallID || got != second.Messages[0].Content[i].ToolCallID {
			t.Fatalf("unstable/colliding ID at %d: %q/%q", i, got, second.Messages[0].Content[i].ToolCallID)
		}
	}
}

func TestTask6CompactionPreservesLargeJSONNumbers(t *testing.T) {
	request := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolName: "lookup", ToolArguments: " { \"n\": 9007199254740993 } "}}},
	}}
	out, report, err := NormalizeToolCallInvariants(request, ToolCallInvariantPreserve)
	if err != nil {
		t.Fatal(err)
	}
	if report.NormalizedArguments != 1 || out.Messages[0].Content[0].ToolArguments != `{"n":9007199254740993}` {
		t.Fatalf("argument value changed: report=%#v args=%q", report, out.Messages[0].Content[0].ToolArguments)
	}
}

func TestTask6ExplicitFreeformArgumentsRemainRaw(t *testing.T) {
	format, err := NewToolFormat(ToolFormatText, "text", nil)
	if err != nil {
		t.Fatal(err)
	}
	request := &NormalizedRequest{
		Model: "fixture", Source: contracts.ProtocolOpenAIChat,
		Tools:    []Tool{{Name: "custom", Kind: ToolKindCustom, Format: format}},
		Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolName: "custom", ToolKind: ToolKindCustom, ToolArguments: "not-json {raw}"}}}},
	}
	out, _, normalizeErr := NormalizeToolCallInvariants(request, ToolCallInvariantPreserve)
	if normalizeErr != nil || out.Messages[0].Content[0].ToolArguments != "not-json {raw}" {
		t.Fatalf("freeform arguments were not preserved: out=%#v err=%v", out, normalizeErr)
	}
}

func TestTask6DuplicateWireIDsPairByOccurrence(t *testing.T) {
	request := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{
			{Type: BlockToolUse, ToolCallID: "reused", ToolName: "a", ToolArguments: "{}"},
			{Type: BlockToolUse, ToolCallID: "reused", ToolName: "b", ToolArguments: "{}"},
		}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "reused", Text: "first"}, {Type: BlockToolResult, ToolCallID: "reused", ToolResultIsError: true, Text: "second"}}},
	}}
	out, report, err := NormalizeToolCallInvariants(request, ToolCallInvariantDrop)
	if err != nil {
		t.Fatal(err)
	}
	if report.DuplicateResults != 1 || len(out.Messages) != 3 {
		t.Fatalf("pairing report/messages = %#v/%#v", report, out.Messages)
	}
	if out.ToolLedger == nil || out.ToolLedger.Len() != 2 {
		t.Fatalf("ledger = %#v", out.ToolLedger)
	}
	occurrences := out.ToolLedger.Occurrences()
	if occurrences[0].State != ToolOccurrenceCompleted || occurrences[1].State != ToolOccurrenceErrored {
		t.Fatalf("occurrence states = %#v", occurrences)
	}
	if out.Messages[0].Content[0].ToolOccurrenceID != "1" || out.Messages[0].Content[1].ToolOccurrenceID != "2" ||
		out.Messages[1].Content[0].ToolOccurrenceID != "1" || out.Messages[2].Content[0].ToolOccurrenceID != "2" {
		t.Fatalf("occurrence block mappings = %#v", out.Messages)
	}
}

func TestTask6SalvageNeverCreatesSuccessfulEmptyResult(t *testing.T) {
	request := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolName: "lookup", ToolArguments: "{}"}}},
	}}
	out, report, err := NormalizeToolCallInvariants(request, ToolCallInvariantSalvage)
	if err != nil {
		t.Fatal(err)
	}
	if report.InterruptedCalls != 1 || len(out.Messages) != 2 {
		t.Fatalf("salvage = %#v messages=%#v", report, out.Messages)
	}
	result := out.Messages[1].Content[0]
	if !result.ToolResultIsError || result.Text == "" {
		t.Fatalf("salvage result was successful/empty: %#v", result)
	}
}

func TestTask6EveryEmittedResultHasOneOccurrence(t *testing.T) {
	for count := 1; count <= 8; count++ {
		calls := make([]ContentBlock, count)
		results := make([]ContentBlock, count)
		for i := range calls {
			id := "same"
			calls[i] = ContentBlock{Type: BlockToolUse, ToolCallID: id, ToolName: fmt.Sprintf("tool-%d", i), ToolArguments: "{}"}
			results[i] = ContentBlock{Type: BlockToolResult, ToolCallID: id, Text: fmt.Sprintf("result-%d", i)}
		}
		request := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{{Role: RoleAssistant, Content: calls}, {Role: RoleTool, Content: results}}}
		out, _, err := NormalizeToolCallInvariants(request, ToolCallInvariantError)
		if err != nil || out.ToolLedger == nil || out.ToolLedger.Len() != count {
			t.Fatalf("count=%d output=%#v err=%v", count, out, err)
		}
		seen := make(map[uint32]int, count)
		for _, occurrence := range out.ToolLedger.Occurrences() {
			seen[occurrence.OccurrenceID]++
		}
		for id, occurrences := range seen {
			if occurrences != 1 {
				t.Fatalf("occurrence %d emitted %d times", id, occurrences)
			}
		}
	}
}
