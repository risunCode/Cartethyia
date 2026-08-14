package transforms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// ToolCallInvariantPolicy controls malformed tool-call history handling.
type ToolCallInvariantPolicy string

const (
	ToolCallInvariantDrop     ToolCallInvariantPolicy = "drop"
	ToolCallInvariantPreserve ToolCallInvariantPolicy = "preserve"
	ToolCallInvariantError    ToolCallInvariantPolicy = "error"
)

// ToolCallInvariantReport is aggregate, bounded bookkeeping for one pass.
type ToolCallInvariantReport struct {
	NormalizedArguments int
	GeneratedCallIDs    int
	DroppedCalls        int
	DroppedResults      int
	DuplicateCalls      int
	DuplicateResults    int
	ReorderedResults    int
}

func (p ToolCallInvariantPolicy) valid() bool {
	return p == ToolCallInvariantDrop || p == ToolCallInvariantPreserve || p == ToolCallInvariantError
}

// ToolCallInvariantStage applies the canonical drop policy in the ordered
// request pipeline. Provider encoders therefore cannot invent separate
// orphan/adjacency repair rules.
type ToolCallInvariantStage struct{}

func (ToolCallInvariantStage) Name() string { return "tool-call-invariants" }

func (ToolCallInvariantStage) Metadata() StageMetadata {
	return StageMetadata{
		Owner: "transforms", ID: "tool-call-invariants", Lossless: true,
		SemanticContract: "tool call IDs, arguments, and result adjacency",
		ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderSchemaTools,
	}
}

func (s ToolCallInvariantStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantDrop)
	if err != nil {
		return nil, contracts.TransformDiagnostic{}, err
	}
	reason := fmt.Sprintf("arguments=%d ids=%d dropped_calls=%d dropped_results=%d reordered=%d", report.NormalizedArguments, report.GeneratedCallIDs, report.DroppedCalls, report.DroppedResults, report.ReorderedResults)
	return out, contracts.TransformDiagnostic{Stage: s.Name(), Action: "normalize", Reason: reason}, nil
}

// NormalizeToolCallInvariants is the single request-side pass for argument
// normalization, stable call IDs, and assistant/tool result adjacency.
func NormalizeToolCallInvariants(req *NormalizedRequest, policy ToolCallInvariantPolicy) (*NormalizedRequest, ToolCallInvariantReport, error) {
	if req == nil {
		return nil, ToolCallInvariantReport{}, pipelineError(CodeInvalidRequest, "", "request", "request is required", nil)
	}
	if !policy.valid() {
		return nil, ToolCallInvariantReport{}, pipelineError(CodeInvalidRequest, surfaceOf(req), "tool_calls.policy", "unsupported tool-call invariant policy", nil)
	}
	out := cloneNormalizedRequest(req)
	var report ToolCallInvariantReport
	usedIDs := make(map[string]struct{})
	for _, message := range out.Messages {
		for _, block := range message.Content {
			if block.Type == BlockToolUse && block.ToolCallID != "" {
				usedIDs[block.ToolCallID] = struct{}{}
			}
		}
	}
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			block := &out.Messages[mi].Content[bi]
			if block.Type != BlockToolUse {
				continue
			}
			args, changed, err := normalizeToolArguments(block.ToolArguments)
			if err != nil {
				return nil, report, pipelineError(CodeUnsupportedFeature, surfaceOf(req), fmt.Sprintf("messages[%d].content[%d].tool_arguments", mi, bi), "tool arguments are not valid JSON", err)
			}
			block.ToolArguments = args
			if changed {
				report.NormalizedArguments++
			}
			if block.ToolCallID == "" {
				block.ToolCallID = uniqueStableToolCallID(block.ToolName, report.GeneratedCallIDs, usedIDs)
				usedIDs[block.ToolCallID] = struct{}{}
				report.GeneratedCallIDs++
			}
		}
	}
	results, duplicateResults := indexToolResults(out.Messages)
	report.DuplicateResults = duplicateResults
	if policy == ToolCallInvariantError {
		if duplicateResults > 0 {
			return nil, report, pipelineError(CodeUnsupportedFeature, surfaceOf(req), "messages", "duplicate tool results are not allowed", nil)
		}
		if err := validateStrictToolAdjacency(out.Messages, results); err != nil {
			return nil, report, pipelineError(CodeUnsupportedFeature, surfaceOf(req), "messages", "tool-call history violates adjacency invariants", err)
		}
		return out, report, nil
	}
	if policy == ToolCallInvariantPreserve {
		return out, report, nil
	}
	normalized, droppedCalls, droppedResults, duplicateCalls, reordered := rebuildToolHistory(out.Messages, results)
	report.DroppedCalls, report.DroppedResults, report.DuplicateCalls, report.ReorderedResults = droppedCalls, droppedResults, duplicateCalls, reordered
	out.Messages = normalized
	return out, report, nil
}

func normalizeToolArguments(raw string) (string, bool, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "{}", raw != "{}", nil
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return "", false, err
	}
	compact, err := json.Marshal(value)
	if err != nil {
		return "", false, err
	}
	return string(compact), string(compact) != raw, nil
}

func stableToolCallID(name string, ordinal int) string {
	base := strings.TrimSpace(name)
	if base == "" {
		base = "unknown"
	}
	if ordinal == 0 {
		return "call_" + base
	}
	return fmt.Sprintf("call_%s_%d", base, ordinal+1)
}
func uniqueStableToolCallID(name string, ordinal int, used map[string]struct{}) string {
	id := stableToolCallID(name, ordinal)
	if _, exists := used[id]; !exists {
		return id
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s_%d", id, suffix)
		if _, exists := used[candidate]; !exists {
			return candidate
		}
	}
}

type toolResultRef struct {
	block ContentBlock
	index int
}

func indexToolResults(messages []NormalizedMessage) (map[string]toolResultRef, int) {
	results := make(map[string]toolResultRef)
	duplicates := 0
	index := 0
	for _, message := range messages {
		for _, block := range message.Content {
			if block.Type != BlockToolResult || block.ToolCallID == "" {
				continue
			}
			if _, exists := results[block.ToolCallID]; exists {
				duplicates++
			}
			results[block.ToolCallID] = toolResultRef{block: block, index: index}
			index++
		}
	}
	return results, duplicates
}

func validateStrictToolAdjacency(messages []NormalizedMessage, results map[string]toolResultRef) error {
	announced := make(map[string]struct{})
	answered := make(map[string]struct{})
	for i, message := range messages {
		if message.Role == RoleAssistant {
			for _, block := range message.Content {
				if block.Type != BlockToolUse {
					continue
				}
				if _, exists := announced[block.ToolCallID]; exists {
					return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "duplicate tool call id"}
				}
				announced[block.ToolCallID] = struct{}{}
				if _, exists := results[block.ToolCallID]; !exists {
					return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "unanswered tool call"}
				}
			}
		}
		if message.Role != RoleTool {
			continue
		}
		for _, block := range message.Content {
			if block.Type != BlockToolResult {
				continue
			}
			if _, exists := announced[block.ToolCallID]; !exists {
				return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "orphan tool result"}
			}
			if _, exists := answered[block.ToolCallID]; exists {
				return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "duplicate tool result"}
			}
			answered[block.ToolCallID] = struct{}{}
		}
	}
	if len(announced) != len(answered) {
		return &protoErr{field: "messages", reason: "tool calls and results do not match"}
	}
	return nil
}

func rebuildToolHistory(messages []NormalizedMessage, results map[string]toolResultRef) ([]NormalizedMessage, int, int, int, int) {
	out := make([]NormalizedMessage, 0, len(messages))
	emittedResults := make(map[string]struct{}, len(results))
	seenCalls := make(map[string]struct{})
	droppedCalls, droppedResults, duplicateCalls, reordered := 0, 0, 0, 0
	for _, message := range messages {
		if message.Role == RoleAssistant {
			kept := make([]ContentBlock, 0, len(message.Content))
			calls := make([]ContentBlock, 0)
			for _, block := range message.Content {
				if block.Type != BlockToolUse {
					kept = append(kept, block)
					continue
				}
				if _, exists := seenCalls[block.ToolCallID]; exists {
					duplicateCalls++
					droppedCalls++
					continue
				}
				seenCalls[block.ToolCallID] = struct{}{}
				result, answered := results[block.ToolCallID]
				if !answered {
					droppedCalls++
					continue
				}
				calls = append(calls, block)
				if result.index != len(emittedResults) {
					reordered++
				}
			}
			if len(calls) == 0 {
				if len(kept) > 0 || message.ReasoningContent != "" || len(message.ReasoningItemsBefore) > 0 {
					message.Content = kept
					out = append(out, message)
				}
				continue
			}
			message.Content = append(kept, calls...)
			out = append(out, message)
			for _, call := range calls {
				result := results[call.ToolCallID]
				emittedResults[call.ToolCallID] = struct{}{}
				out = append(out, NormalizedMessage{Role: RoleTool, Content: []ContentBlock{result.block}})
			}
			continue
		}
		if message.Role == RoleTool {
			kept := make([]ContentBlock, 0, len(message.Content))
			for _, block := range message.Content {
				if block.Type != BlockToolResult {
					kept = append(kept, block)
					continue
				}
				if _, known := results[block.ToolCallID]; !known {
					droppedResults++
					continue
				}
				if _, emitted := emittedResults[block.ToolCallID]; !emitted {
					droppedResults++
				}
			}
			if len(kept) > 0 {
				message.Content = kept
				out = append(out, message)
			}
			continue
		}
		out = append(out, message)
	}
	for id := range results {
		if _, emitted := emittedResults[id]; !emitted {
			droppedResults++
		}
	}
	return out, droppedCalls, droppedResults, duplicateCalls, reordered
}
