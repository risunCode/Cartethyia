package usage

import (
	"encoding/json"
	"strings"
	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func int64Ptr(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}

// ExtractProviderTokens calculates exact usage numbers based on provider/surface wire formats.
func ExtractProviderTokens(provider string, surface contracts.Surface, rawBody []byte) (Tokens, bool) {
	if len(rawBody) == 0 {
		return Tokens{}, false
	}

	p := strings.ToLower(provider)

	// 1. Anthropic format
	if p == "anthropic" || surface == contracts.SurfaceAnthropic {
		var payload struct {
			Usage struct {
				InputTokens              int64 `json:"input_tokens"`
				OutputTokens             int64 `json:"output_tokens"`
				CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(rawBody, &payload); err == nil && (payload.Usage.InputTokens > 0 || payload.Usage.OutputTokens > 0) {
			input := payload.Usage.InputTokens
			output := payload.Usage.OutputTokens
			cacheRead := payload.Usage.CacheReadInputTokens
			cacheWrite := payload.Usage.CacheCreationInputTokens
			prompt := input + cacheRead + cacheWrite
			total := prompt + output
			return Tokens{
				Input:        int64Ptr(prompt),
				Output:       int64Ptr(output),
				Total:        int64Ptr(total),
				CachedRead:   int64Ptr(cacheRead),
				CachedWrite:  int64Ptr(cacheWrite),
			}, true
		}
	}

	// 2. Gemini format
	if p == "gemini" || p == "vertex" || p == "antigravity" || surface == contracts.SurfaceGemini {
		var payload struct {
			UsageMetadata struct {
				PromptTokenCount        int64 `json:"promptTokenCount"`
				CandidatesTokenCount    int64 `json:"candidatesTokenCount"`
				TotalTokenCount         int64 `json:"totalTokenCount"`
				CachedContentTokenCount int64 `json:"cachedContentTokenCount"`
				ThoughtsTokenCount      int64 `json:"thoughtsTokenCount"`
			} `json:"usageMetadata"`
		}
		if err := json.Unmarshal(rawBody, &payload); err == nil && (payload.UsageMetadata.PromptTokenCount > 0 || payload.UsageMetadata.TotalTokenCount > 0) {
			prompt := payload.UsageMetadata.PromptTokenCount
			cached := payload.UsageMetadata.CachedContentTokenCount
			thoughts := payload.UsageMetadata.ThoughtsTokenCount
			candidates := payload.UsageMetadata.CandidatesTokenCount
			total := payload.UsageMetadata.TotalTokenCount
			if candidates == 0 && total > 0 {
				candidates = total - prompt - thoughts
				if candidates < 0 {
					candidates = 0
				}
			}
			output := candidates + thoughts
			if total == 0 {
				total = prompt + output
			}
			return Tokens{
				Input:       int64Ptr(prompt),
				Output:      int64Ptr(output),
				Total:       int64Ptr(total),
				CachedRead:  int64Ptr(cached),
				Reasoning:   int64Ptr(thoughts),
			}, true
		}
	}

	// 3. OpenAI format (standard chat completions & responses)
	var openaiPayload struct {
		Usage struct {
			PromptTokens        int64 `json:"prompt_tokens"`
			CompletionTokens    int64 `json:"completion_tokens"`
			TotalTokens         int64 `json:"total_tokens"`
			InputTokens         int64 `json:"input_tokens"`
			OutputTokens        int64 `json:"output_tokens"`
			PromptTokensDetails struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionTokensDetails struct {
				ReasoningTokens int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rawBody, &openaiPayload); err == nil {
		prompt := openaiPayload.Usage.PromptTokens
		if prompt == 0 {
			prompt = openaiPayload.Usage.InputTokens
		}
		completion := openaiPayload.Usage.CompletionTokens
		if completion == 0 {
			completion = openaiPayload.Usage.OutputTokens
		}
		total := openaiPayload.Usage.TotalTokens
		if total == 0 && (prompt > 0 || completion > 0) {
			total = prompt + completion
		}
		cached := openaiPayload.Usage.PromptTokensDetails.CachedTokens
		reasoning := openaiPayload.Usage.CompletionTokensDetails.ReasoningTokens

		if prompt > 0 || completion > 0 || total > 0 {
			return Tokens{
				Input:      int64Ptr(prompt),
				Output:     int64Ptr(completion),
				Total:      int64Ptr(total),
				CachedRead: int64Ptr(cached),
				Reasoning:  int64Ptr(reasoning),
			}, true
		}
	}

	return Tokens{}, false
}
