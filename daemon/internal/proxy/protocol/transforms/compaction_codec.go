package transforms

import (
	"context"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/jsonclone"
)

// DecodeCompactionRequest decodes compact V1/V2 using the same canonical
// projector as ordinary Responses ingress. V1 is the non-trigger request;
// V2 requires a final compaction_trigger item in the input sequence.
func DecodeCompactionRequest(ctx context.Context, protocol contracts.Protocol, body []byte, version CompactionVersion, stream bool) (*NormalizedRequest, *TransformError) {
	if version != CompactionV1 && version != CompactionV2 {
		return nil, newTransformError(CodeInvalidCompaction, "decode-compaction", string(protocol), "version", "unsupported compaction version", nil)
	}
	if protocol == contracts.ProtocolAnthropic {
		return nil, newTransformError(CodeUnsupportedFeature, "decode-compaction", string(protocol), "operation", "Anthropic context management is distinct from remote compaction", nil)
	}
	if protocol != contracts.ProtocolOpenAIResponse {
		return nil, newTransformError(CodeUnsupportedFeature, "decode-compaction", string(protocol), "protocol", "compaction codec requires the Responses surface", nil)
	}
	req, err := NewOpenAIResponsesRequestDecoder().Decode(ctx, body, stream)
	if err != nil {
		if err.Code == CodeContextCanceled {
			return nil, err
		}
		return nil, newTransformError(CodeInvalidCompaction, "decode-compaction", string(protocol), "input", err.Error(), nil)
	}
	if version == CompactionV2 && req.Operation.Kind != OperationCompactV2 {
		return nil, newTransformError(CodeInvalidCompaction, "decode-compaction", string(protocol), "input", "V2 compaction requires a compaction_trigger item", nil)
	}
	if version == CompactionV1 && req.Operation.Kind == OperationCompactV2 {
		return nil, newTransformError(CodeInvalidCompaction, "decode-compaction", string(protocol), "input", "V1 compaction cannot contain a V2 trigger", nil)
	}
	input := make([]CompactionItem, 0, len(req.Messages)*2)
	if version == CompactionV2 && req.Operation.Compaction != nil {
		input = append(input, req.Operation.Compaction.Input...)
	} else {
		for _, message := range req.Messages {
			input = append(input, message.Content...)
		}
	}
	compact, compactErr := NewCompactionRequest(CompactionRequestInput{Version: version, Model: req.Model, Input: input, Instructions: firstSystemInstruction(req.Messages), Tools: req.Tools, Reasoning: req.ReasoningConfig, Include: req.Include, SessionKey: req.ConversationID, PromptCacheKey: req.CacheKey})
	if compactErr != nil {
		return nil, compactErr
	}
	op, opErr := NewCompactionOperation(compact)
	if opErr != nil {
		return nil, opErr
	}
	req.Operation = op
	return req, nil
}

// EncodeCompactionRequest renders a canonical compaction request in the
// requesting Responses grammar. The V1 marker is explicit and V2 retains its
// final trigger; no ordinary generation body is accepted as compaction.
func EncodeCompactionRequest(ctx context.Context, protocol contracts.Protocol, req *NormalizedRequest) (*EncoderResult, *TransformError) {
	if req == nil {
		return nil, newTransformError(CodeInvalidCompaction, "encode-compaction", string(protocol), "request", "request must not be nil", nil)
	}
	if req.Operation.Kind != OperationCompactV1 && req.Operation.Kind != OperationCompactV2 {
		return nil, newTransformError(CodeInvalidCompaction, "encode-compaction", string(protocol), "operation", "request is not a compaction operation", nil)
	}
	if protocol != contracts.ProtocolOpenAIResponse {
		return nil, newTransformError(CodeUnsupportedFeature, "encode-compaction", string(protocol), "protocol", "compaction codec requires the Responses surface", nil)
	}
	if req.Operation.Compaction == nil {
		return nil, newTransformError(CodeInvalidCompaction, "encode-compaction", string(protocol), "operation.compaction", "compaction request is required", nil)
	}
	if req.Operation.Kind == OperationCompactV2 {
		return NewOpenAIResponsesCodec().Encode(ctx, req)
	}
	// V1 uses the same canonical input projector without a V2 trigger. The
	// compact marker is provider-owned and remains visible to policy/planning.
	input := encodeCompactionV1ResponsesInput(req.Operation.Compaction)
	payload := map[string]any{"model": req.Model, "input": input, "stream": false, "compact": true}
	if req.Operation.Compaction.Instructions != "" {
		payload["instructions"] = req.Operation.Compaction.Instructions
	}
	if len(req.Operation.Compaction.Tools) > 0 {
		payload["tools"] = encodeResponsesTools(req.Operation.Compaction.Tools)
	}
	if req.Operation.Compaction.PromptCacheKey != "" {
		payload["prompt_cache_key"] = req.Operation.Compaction.PromptCacheKey
	}
	if err := req.Operation.Compaction.Validate(); err != nil {
		return nil, err
	}
	if err := validateWirePayload(contracts.ProtocolOpenAIResponse, payload); err != nil {
		return nil, err
	}
	return &EncoderResult{Wire: payload, Dispositions: []FieldDisposition{{Path: "operation", Action: DispositionPreserved, Reason: "compact-v1"}}}, nil
}

func encodeCompactionV1ResponsesInput(request *CompactionRequest) []map[string]any {
	if request == nil {
		return nil
	}
	input := make([]map[string]any, 0, len(request.Input))
	for _, block := range request.Input {
		switch block.Type {
		case BlockCompactionTrigger:
			continue
		case BlockText:
			input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": block.Text}}})
		case BlockImage:
			input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_image", "image_url": openAIImageURL(block.Image)}}})
		case BlockAudio:
			if block.Audio != nil {
				input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_audio", "audio_data": block.Audio.Value, "format": audioFormat(block.Audio.MIMEType)}}})
			}
		case BlockFile, BlockDocument, BlockPDF:
			if media := contentMediaReference(block); media != nil {
				input = append(input, map[string]any{"type": "message", "role": "user", "content": []map[string]any{encodeResponsesFileReference(media)}})
			}
		case BlockReasoning:
			input = append(input, encodeResponsesReasoningItem(block))
		case BlockToolUse:
			input = append(input, map[string]any{"type": "function_call", "call_id": block.ToolCallID, "name": block.ToolName, "arguments": block.ToolArguments})
		case BlockToolResult:
			input = append(input, map[string]any{"type": "function_call_output", "call_id": block.ToolCallID, "output": block.Text})
		default:
			if block.Raw != nil {
				input = append(input, jsonclone.CloneMap(block.Raw))
			}
		}
	}
	return input
}

// BridgeCompactionRequest changes only the operation version. It is intended
// for an already-approved policy bridge; callers must still record the bridge
// disposition and target capability generation.
func BridgeCompactionRequest(request *CompactionRequest, target CompactionVersion) (*CompactionRequest, *TransformError) {
	if request == nil {
		return nil, newTransformError(CodeInvalidCompaction, "bridge-compaction", "", "request", "request must not be nil", nil)
	}
	if target != CompactionV1 && target != CompactionV2 {
		return nil, newTransformError(CodeInvalidCompaction, "bridge-compaction", "", "version", "unsupported target compaction version", nil)
	}
	copyRequest, err := NewCompactionRequest(*request)
	if err != nil {
		return nil, err
	}
	copyRequest.Version = target
	for i := range copyRequest.Input {
		if copyRequest.Input[i].Compaction != nil {
			copyRequest.Input[i].Compaction.Version = target
		}
		if target == CompactionV1 && copyRequest.Input[i].Type == BlockCompactionTrigger {
			copyRequest.Input = append(copyRequest.Input[:i], copyRequest.Input[i+1:]...)
			break
		}
	}
	if target == CompactionV2 {
		hasTrigger := false
		for _, item := range copyRequest.Input {
			if item.Type == BlockCompactionTrigger {
				hasTrigger = true
				break
			}
		}
		if !hasTrigger {
			copyRequest.Input = append(copyRequest.Input, ContentBlock{Type: BlockCompactionTrigger, Compaction: &CompactionContent{Version: CompactionV2, Kind: CompactionItemTrigger}})
		}
	}
	if validateErr := copyRequest.Validate(); validateErr != nil {
		return nil, validateErr
	}
	return copyRequest, nil
}

func encodeResponsesTools(tools []Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		if tool.NativeType != "" {
			value := jsonclone.CloneMap(tool.NativeOptions)
			if value == nil {
				value = map[string]any{}
			}
			value["type"] = tool.NativeType
			out = append(out, value)
			continue
		}
		out = append(out, map[string]any{"type": "function", "name": tool.Name, "description": nilIfEmpty(tool.Description), "parameters": tool.InputSchema})
	}
	return out
}
