package codec

import (
	"context"
	"encoding/json"
	"fmt"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	"io"
	"strings"
)

// ToolCallInvariantPolicy controls malformed tool-call history handling.
type ToolCallInvariantPolicy string

const (
	ToolCallInvariantDrop     ToolCallInvariantPolicy = "drop"
	ToolCallInvariantPreserve ToolCallInvariantPolicy = "preserve"
	ToolCallInvariantError    ToolCallInvariantPolicy = "error"
	// ToolCallInvariantSalvage is opt-in and emits an explicit error result for
	// interrupted calls. It never fabricates a successful empty result.
	ToolCallInvariantSalvage ToolCallInvariantPolicy = "salvage"
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
	InterruptedCalls    int
}

func (p ToolCallInvariantPolicy) valid() bool {
	return p == ToolCallInvariantDrop || p == ToolCallInvariantPreserve || p == ToolCallInvariantError || p == ToolCallInvariantSalvage
}

// ToolCallInvariantStage is the fail-closed request-side tool history pass.
// Lossy salvage is available only to callers that explicitly select Drop;
// provider encoders therefore cannot invent separate orphan/adjacency rules.
type ToolCallInvariantStage struct{}

func (ToolCallInvariantStage) Name() string { return "tool-call-invariants" }

func (ToolCallInvariantStage) Metadata() StageMetadata {
	return StageMetadata{
		Owner: "codec", ID: "tool-call-invariants", Lossless: true,
		SemanticContract: "tool call IDs, arguments, and result adjacency",
		ActivationPolicy: "always", CachePrefixEffect: "preserve", Order: orderSchemaTools,
	}
}

func (s ToolCallInvariantStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	out, report, err := NormalizeToolCallInvariants(req, ToolCallInvariantError)
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
			if block.Type == BlockToolUse || block.Type == BlockServerToolUse {
				if callID := contentBlockCallID(block); callID != "" {
					usedIDs[callID] = struct{}{}
				}
			}
		}
	}
	for mi := range out.Messages {
		for bi := range out.Messages[mi].Content {
			block := &out.Messages[mi].Content[bi]
			if block.Type != BlockToolUse && block.Type != BlockServerToolUse {
				continue
			}
			if block.Type == BlockToolUse {
				args, changed, err := normalizeToolArguments(block.ToolArguments, toolArgumentsAreFreeform(out, *block))
				if err != nil {
					return nil, report, pipelineError(CodeUnsupportedFeature, surfaceOf(req), fmt.Sprintf("messages[%d].content[%d].tool_arguments", mi, bi), "tool arguments are not valid JSON for this tool", err)
				}
				block.ToolArguments = args
				if changed {
					report.NormalizedArguments++
				}
			}
			if block.ToolName == "" && block.ServerTool != nil {
				block.ToolName = block.ServerTool.Name
			}
			callID := contentBlockCallID(*block)
			if callID == "" {
				block.ToolCallID = uniqueStableToolCallIDAt(contentBlockToolName(*block), mi, bi, usedIDs)
				usedIDs[block.ToolCallID] = struct{}{}
				report.GeneratedCallIDs++
			} else if block.ToolCallID == "" {
				block.ToolCallID = callID
			}
			if block.ServerTool != nil {
				block.ServerTool.CallID = block.ToolCallID
			}
		}
	}
	results, duplicateResults := indexToolResults(out.Messages)
	report.DuplicateResults = duplicateResults
	if policy == ToolCallInvariantError {
		if err := validateStrictToolAdjacency(out.Messages, results); err != nil {
			return nil, report, pipelineError(CodeUnsupportedFeature, surfaceOf(req), "messages", "tool-call history violates adjacency invariants", err)
		}
		annotateToolOccurrences(out.Messages)
		out.ToolLedger = buildToolOccurrenceLedger(out.Messages)
		return out, report, nil
	}
	if policy == ToolCallInvariantPreserve {
		annotateToolOccurrences(out.Messages)
		out.ToolLedger = buildToolOccurrenceLedger(out.Messages)
		return out, report, nil
	}
	normalized, droppedCalls, droppedResults, duplicateCalls, reordered, interrupted := rebuildToolHistory(out.Messages, results, policy == ToolCallInvariantSalvage)
	report.DroppedCalls, report.DroppedResults, report.DuplicateCalls, report.ReorderedResults, report.InterruptedCalls = droppedCalls, droppedResults, duplicateCalls, reordered, interrupted
	out.Messages = normalized
	annotateToolOccurrences(out.Messages)
	out.ToolLedger = buildToolOccurrenceLedger(out.Messages)
	return out, report, nil
}

func annotateToolOccurrences(messages []NormalizedMessage) {
	byID := make(map[string][]string)
	next := 1
	for mi := range messages {
		for bi := range messages[mi].Content {
			block := &messages[mi].Content[bi]
			if block.Type != BlockToolUse && block.Type != BlockServerToolUse {
				continue
			}
			id := contentBlockCallID(*block)
			occurrenceID := itoa(next)
			next++
			block.ToolOccurrenceID = occurrenceID
			byID[id] = append(byID[id], occurrenceID)
		}
	}
	for mi := range messages {
		for bi := range messages[mi].Content {
			block := &messages[mi].Content[bi]
			if block.Type != BlockToolResult && block.Type != BlockServerToolResult {
				continue
			}
			id := contentBlockCallID(*block)
			queue := byID[id]
			if len(queue) == 0 {
				continue
			}
			block.ToolOccurrenceID = queue[0]
			byID[id] = queue[1:]
		}
	}
}

func buildToolOccurrenceLedger(messages []NormalizedMessage) *ToolOccurrenceLedger {
	occurrences := make([]ToolOccurrence, 0)
	byID := make(map[string][]int)
	for messageIndex, message := range messages {
		for blockIndex, block := range message.Content {
			if block.Type != BlockToolUse && block.Type != BlockServerToolUse {
				continue
			}
			kind := block.ToolKind
			if kind == "" && block.ServerTool != nil {
				kind = block.ServerTool.Kind
			}
			if kind == "" {
				kind = ToolKindFunction
			}
			callID := contentBlockCallID(block)
			occurrenceID := uint32(len(occurrences) + 1)
			occurrences = append(occurrences, ToolOccurrence{OccurrenceID: occurrenceID, SourceWireID: callID, TargetWireID: callID, ItemID: block.ToolItemID, CallID: callID, Kind: kind, Name: contentBlockToolName(block), State: ToolOccurrenceCalled, MessageIndex: Value(messageIndex), BlockIndex: Value(blockIndex)})
			byID[callID] = append(byID[callID], len(occurrences)-1)
		}
	}
	for _, message := range messages {
		for _, block := range message.Content {
			if block.Type != BlockToolResult && block.Type != BlockServerToolResult {
				continue
			}
			indexes := byID[contentBlockCallID(block)]
			if len(indexes) == 0 {
				continue
			}
			index := indexes[0]
			byID[contentBlockCallID(block)] = indexes[1:]
			occurrences[index].State = ToolOccurrenceErrored
			resultIsError := block.ToolResultIsError
			if block.ServerTool != nil {
				resultIsError = resultIsError || block.ServerTool.IsError
			}
			if !resultIsError {
				occurrences[index].State = ToolOccurrenceCompleted
			}
			occurrences[index].ResultIsError = resultIsError
		}
	}
	for i := range occurrences {
		if occurrences[i].State == ToolOccurrenceCalled {
			occurrences[i].State = ToolOccurrenceInterrupted
		}
	}
	ledger, err := NewToolOccurrenceLedger(occurrences)
	if err != nil {
		return nil
	}
	return ledger
}

func normalizeToolArguments(raw string, freeformOption ...bool) (string, bool, error) {
	trimmed := strings.TrimSpace(raw)
	freeform := len(freeformOption) > 0 && freeformOption[0]
	if freeform {
		return raw, false, nil
	}
	if trimmed == "" {
		return "{}", raw != "{}", nil
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", false, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return "", false, fmt.Errorf("multiple JSON values")
		}
		return "", false, err
	}
	compact, err := json.Marshal(value)
	if err != nil {
		return "", false, err
	}
	return string(compact), string(compact) != raw, nil
}

func stableToolCallID(name string, ordinal int) string {
	base := sanitizeToolName(name)
	if ordinal == 0 {
		return "call_" + base
	}
	return fmt.Sprintf("call_%s_%d", base, ordinal+1)
}

// uniqueStableToolCallIDAt derives identity from canonical message and block
// position, not from the number of missing IDs encountered before it. This
// makes IDs stable when unrelated content is inserted or removed.
func uniqueStableToolCallIDAt(name string, messageIndex, blockIndex int, used map[string]struct{}) string {
	base := fmt.Sprintf("call_%s_m%d_b%d", sanitizeToolName(name), messageIndex, blockIndex)
	if _, exists := used[base]; !exists {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s_%d", base, suffix)
		if _, exists := used[candidate]; !exists {
			return candidate
		}
	}
}

func sanitizeToolName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return "unknown"
	}
	var b strings.Builder
	b.Grow(len(name))
	lastUnderscore := false
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			if r == '-' {
				r = '_'
			}
			b.WriteRune(r)
			lastUnderscore = r == '_'
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	result := strings.Trim(b.String(), "_")
	if result == "" {
		return "unknown"
	}
	return result
}

func toolArgumentsAreFreeform(req *NormalizedRequest, block ContentBlock) bool {
	if req == nil {
		return false
	}
	for _, tool := range req.Tools {
		if tool.Name != block.ToolName || (tool.Kind != "" && block.ToolKind != "" && tool.Kind != block.ToolKind) {
			continue
		}
		return tool.Format != nil && tool.Format.Kind != ToolFormatJSON
	}
	return false
}

func contentBlockCallID(block ContentBlock) string {
	if block.ToolCallID != "" {
		return block.ToolCallID
	}
	if block.ServerTool != nil {
		return block.ServerTool.CallID
	}
	return ""
}

func contentBlockToolName(block ContentBlock) string {
	if block.ToolName != "" {
		return block.ToolName
	}
	if block.ServerTool != nil {
		return block.ServerTool.Name
	}
	return ""
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

func indexToolResults(messages []NormalizedMessage) (map[string][]toolResultRef, int) {
	results := make(map[string][]toolResultRef)
	duplicates := 0
	index := 0
	for _, message := range messages {
		for _, block := range message.Content {
			callID := contentBlockCallID(block)
			if (block.Type != BlockToolResult && block.Type != BlockServerToolResult) || callID == "" {
				continue
			}
			if len(results[callID]) > 0 {
				duplicates++
			}
			results[callID] = append(results[callID], toolResultRef{block: block, index: index})
			index++
		}
	}
	return results, duplicates
}

func validateStrictToolAdjacency(messages []NormalizedMessage, results map[string][]toolResultRef) error {
	announced := make(map[string]int)
	answered := make(map[string]int)
	for i, message := range messages {
		if message.Role == RoleAssistant {
			for _, block := range message.Content {
				if block.Type != BlockToolUse && block.Type != BlockServerToolUse {
					continue
				}
				callID := contentBlockCallID(block)
				announced[callID]++
				if len(results[callID]) < announced[callID] {
					return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "unanswered tool call"}
				}
			}
		}
		if message.Role != RoleTool {
			continue
		}
		for _, block := range message.Content {
			if block.Type != BlockToolResult && block.Type != BlockServerToolResult {
				continue
			}
			callID := contentBlockCallID(block)
			if answered[callID] >= announced[callID] {
				return &protoErr{field: fmt.Sprintf("messages[%d]", i), reason: "orphan tool result"}
			}
			answered[callID]++
		}
	}
	if len(announced) != len(answered) {
		return &protoErr{field: "messages", reason: "tool calls and results do not match"}
	}
	for id, count := range announced {
		if answered[id] != count {
			return &protoErr{field: "messages", reason: "tool calls and results do not match"}
		}
	}
	return nil
}

func rebuildToolHistory(messages []NormalizedMessage, results map[string][]toolResultRef, salvageInterrupted bool) ([]NormalizedMessage, int, int, int, int, int) {
	out := make([]NormalizedMessage, 0, len(messages))
	consumed := make(map[string]int, len(results))
	droppedCalls, droppedResults, duplicateCalls, reordered, interrupted := 0, 0, 0, 0, 0
	emittedCount := 0
	for _, message := range messages {
		if message.Role == RoleAssistant {
			kept := make([]ContentBlock, 0, len(message.Content))
			type pairedCall struct {
				call   ContentBlock
				result toolResultRef
			}
			calls := make([]pairedCall, 0)
			for _, block := range message.Content {
				if block.Type != BlockToolUse && block.Type != BlockServerToolUse {
					kept = append(kept, block)
					continue
				}
				callID := contentBlockCallID(block)
				ordinal := consumed[callID]
				queue := results[callID]
				if ordinal > 0 {
					duplicateCalls++
				}
				if ordinal >= len(queue) {
					if salvageInterrupted {
						interrupted++
						resultType := BlockToolResult
						if block.Type == BlockServerToolUse {
							resultType = BlockServerToolResult
						}
						calls = append(calls, pairedCall{call: block, result: toolResultRef{block: ContentBlock{Type: resultType, ToolCallID: callID, ToolResultIsError: true, Text: "tool call interrupted"}, index: emittedCount}})
						continue
					}
					droppedCalls++
					continue
				}
				result := queue[ordinal]
				consumed[callID] = ordinal + 1
				calls = append(calls, pairedCall{call: block, result: result})
				if result.index != emittedCount {
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
			pairedBlocks := make([]ContentBlock, 0, len(calls))
			for _, call := range calls {
				pairedBlocks = append(pairedBlocks, call.call)
			}
			message.Content = append(kept, pairedBlocks...)
			out = append(out, message)
			for _, call := range calls {
				emittedCount++
				out = append(out, NormalizedMessage{Role: RoleTool, Content: []ContentBlock{call.result.block}})
			}
			continue
		}
		if message.Role == RoleTool {
			kept := make([]ContentBlock, 0, len(message.Content))
			for _, block := range message.Content {
				if block.Type != BlockToolResult && block.Type != BlockServerToolResult {
					kept = append(kept, block)
					continue
				}
				callID := contentBlockCallID(block)
				queue := results[callID]
				ordinal := consumed[callID]
				if ordinal >= len(queue) {
					if len(queue) == 0 {
						droppedResults++
					}
					continue
				}
				// Every original result is re-emitted from its paired occurrence above;
				// never retain the source result and risk a duplicate output.
				droppedResults++
			}
			if len(kept) > 0 {
				message.Content = kept
				out = append(out, message)
			}
			continue
		}
		out = append(out, message)
	}
	for id, queue := range results {
		if n := consumed[id]; n < len(queue) {
			droppedResults += len(queue) - n
		}
	}
	return out, droppedCalls, droppedResults, duplicateCalls, reordered, interrupted
}
