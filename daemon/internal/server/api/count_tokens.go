package api

import (
	"encoding/json"
	"net/http"
	"unicode/utf8"

	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

const maxCountedTokens = 1 << 20

// handleCountTokens implements Anthropic's bounded input-token endpoint. The
// repository does not ship Anthropic's exact tokenizer, so this endpoint uses
// a documented conservative estimator: every Unicode scalar value contributes
// one token, with one structural token per message/block/tool and a fixed 256
// token allowance per image. This intentionally overestimates typical BPE
// tokenization while remaining deterministic and independent of provider I/O.
func handleCountTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		MethodNotAllowed(w, http.MethodPost)
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "count_tokens requires Content-Type: application/json")
		return
	}
	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}
	decoded, transformErr := transforms.NewAnthropicMessagesRequestDecoder().Decode(r.Context(), body, false)
	if transformErr != nil {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "count_tokens request is invalid")
		return
	}
	count, ok := estimateInputTokens(decoded)
	if !ok {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "count_tokens request exceeds the counting bound")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"input_tokens": count})
}

func estimateInputTokens(req *transforms.NormalizedRequest) (int, bool) {
	if req == nil {
		return 0, false
	}
	count := 0
	add := func(value int) bool {
		if value < 0 || count > maxCountedTokens-value {
			return false
		}
		count += value
		return true
	}
	for _, message := range req.Messages {
		if !add(1) || !add(utf8.RuneCountInString(string(message.Role))) {
			return 0, false
		}
		for _, block := range message.Content {
			if !add(1) {
				return 0, false
			}
			switch block.Type {
			case transforms.BlockImage:
				if !add(256) {
					return 0, false
				}
			case transforms.BlockToolUse:
				if !add(utf8.RuneCountInString(block.ToolName)) || !add(utf8.RuneCountInString(block.ToolCallID)) || !add(utf8.RuneCountInString(block.ToolArguments)) {
					return 0, false
				}
			case transforms.BlockReasoning:
				if !add(utf8.RuneCountInString(block.ReasoningText)) || !add(utf8.RuneCountInString(block.ReasoningSignature)) {
					return 0, false
				}
			default:
				if !add(utf8.RuneCountInString(block.Text)) {
					return 0, false
				}
			}
		}
	}
	for _, tool := range req.Tools {
		if !add(1) || !add(utf8.RuneCountInString(tool.Name)) || !add(utf8.RuneCountInString(tool.Description)) {
			return 0, false
		}
		if len(tool.InputSchema) > 0 {
			raw, err := json.Marshal(tool.InputSchema)
			if err != nil || !add(utf8.RuneCountInString(string(raw))) {
				return 0, false
			}
		}
	}
	return count, true
}
