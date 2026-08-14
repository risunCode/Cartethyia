package transforms

import (
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestNormalizeToolCallInvariantsCompactsArgumentsOnceAndPreservesIDs(t *testing.T) {
	id := "call_original"
	req := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolCallID: id, ToolName: "lookup", ToolArguments: " { \"q\": \"x\" } " }}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: id, Text: "{\"ok\":true}"}}},
	}}
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	if err != nil { t.Fatal(err) }
	call := out.Messages[0].Content[0]
	if call.ToolCallID != id || call.ToolArguments != `{"q":"x"}` { t.Fatalf("call identity/arguments changed: %#v", call) }
	if report.NormalizedArguments != 1 || report.DroppedCalls != 0 { t.Fatalf("unexpected report: %#v", report) }
	if len(out.Messages) != 2 || out.Messages[1].Content[0].ToolCallID != id { t.Fatalf("adjacency lost: %#v", out.Messages) }
	if req.Messages[0].Content[0].ToolArguments != " { \"q\": \"x\" } " { t.Fatal("input mutated") }
}

func TestNormalizeToolCallInvariantsDropsOrphansAndUnansweredCalls(t *testing.T) {
	req := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolCallID: "call_answered", ToolName: "a", ToolArguments: "{}"}, {Type: BlockToolUse, ToolCallID: "call_missing", ToolName: "b", ToolArguments: "{}"}}},
		{Role: RoleUser, Content: []ContentBlock{{Type: BlockText, Text: "intervening"}}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "orphan", Text: "bad"}}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "call_answered", Text: "ok"}}},
	}}
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	if err != nil { t.Fatal(err) }
	if report.DroppedCalls != 1 || report.DroppedResults < 1 { t.Fatalf("unexpected report: %#v", report) }
	if len(out.Messages) != 3 || out.Messages[0].Role != RoleAssistant || out.Messages[1].Role != RoleTool || out.Messages[2].Role != RoleUser { t.Fatalf("adjacency = %#v", out.Messages) }
	if len(out.Messages[0].Content) != 1 || out.Messages[0].Content[0].ToolCallID != "call_answered" || out.Messages[1].Content[0].ToolCallID != "call_answered" { t.Fatalf("wrong pair = %#v", out.Messages) }
}

func TestNormalizeToolCallInvariantsReordersResultsToCallOrder(t *testing.T) {
	req := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolCallID: "a", ToolName: "a", ToolArguments: "{}"}, {Type: BlockToolUse, ToolCallID: "b", ToolName: "b", ToolArguments: "{}"}}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "b", Text: "b-result"}}},
		{Role: RoleTool, Content: []ContentBlock{{Type: BlockToolResult, ToolCallID: "a", Text: "a-result"}}},
	}}
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	if err != nil { t.Fatal(err) }
	if report.ReorderedResults == 0 || len(out.Messages) != 3 { t.Fatalf("expected reorder: %#v", report) }
	if out.Messages[1].Content[0].ToolCallID != "a" || out.Messages[2].Content[0].ToolCallID != "b" { t.Fatalf("order = %#v", out.Messages) }
}

func TestNormalizeToolCallInvariantsRejectsMalformedArguments(t *testing.T) {
	req := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ToolName: "lookup", ToolArguments: "{bad"}}}}}
	if _, _, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop); err == nil { t.Fatal("expected malformed arguments rejection") }
}

func TestNormalizeToolCallInvariantsGeneratesUniqueMissingIDs(t *testing.T) {
	message := NormalizedMessage{Role: RoleAssistant}
	message.Content = []ContentBlock{
		{Type: BlockToolUse, ToolName: "lookup", ToolArguments: "{}"},
		{Type: BlockToolUse, ToolName: "lookup", ToolArguments: "{}"},
		{Type: BlockToolUse, ToolName: "lookup", ToolCallID: "call_lookup", ToolArguments: "{}"},
	}
	req := &NormalizedRequest{Model: "fixture", Source: contracts.ProtocolOpenAIChat, Messages: []NormalizedMessage{message}}
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantPreserve)
	if err != nil { t.Fatal(err) }
	calls := out.Messages[0].Content
	if report.GeneratedCallIDs != 2 || calls[0].ToolCallID == calls[1].ToolCallID || calls[0].ToolCallID == calls[2].ToolCallID || calls[1].ToolCallID == calls[2].ToolCallID { t.Fatalf("generated IDs collided: report=%#v calls=%#v", report, calls) }
}
