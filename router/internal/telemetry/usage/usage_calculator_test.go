package usage

import (
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestExtractProviderTokens_Anthropic(t *testing.T) {
	raw := []byte(`{
		"usage": {
			"input_tokens": 100,
			"output_tokens": 50,
			"cache_read_input_tokens": 200,
			"cache_creation_input_tokens": 50
		}
	}`)

	tokens, ok := ExtractProviderTokens("anthropic", contracts.SurfaceAnthropic, raw)
	if !ok {
		t.Fatal("expected ExtractProviderTokens to return true")
	}
	if tokens.Input == nil || *tokens.Input != 350 {
		t.Errorf("expected input 350 (100+200+50), got %v", tokens.Input)
	}
	if tokens.CachedRead == nil || *tokens.CachedRead != 200 {
		t.Errorf("expected cachedRead 200, got %v", tokens.CachedRead)
	}
	if tokens.CachedWrite == nil || *tokens.CachedWrite != 50 {
		t.Errorf("expected cachedWrite 50, got %v", tokens.CachedWrite)
	}
	if tokens.Output == nil || *tokens.Output != 50 {
		t.Errorf("expected output 50, got %v", tokens.Output)
	}
	if tokens.Total == nil || *tokens.Total != 400 {
		t.Errorf("expected total 400, got %v", tokens.Total)
	}
}

func TestExtractProviderTokens_Gemini(t *testing.T) {
	raw := []byte(`{
		"usageMetadata": {
			"promptTokenCount": 120,
			"candidatesTokenCount": 80,
			"thoughtsTokenCount": 30,
			"totalTokenCount": 230,
			"cachedContentTokenCount": 40
		}
	}`)

	tokens, ok := ExtractProviderTokens("gemini", contracts.SurfaceGemini, raw)
	if !ok {
		t.Fatal("expected ExtractProviderTokens to return true")
	}
	if tokens.Input == nil || *tokens.Input != 120 {
		t.Errorf("expected input 120, got %v", tokens.Input)
	}
	if tokens.Output == nil || *tokens.Output != 110 {
		t.Errorf("expected output 110 (80+30), got %v", tokens.Output)
	}
	if tokens.Reasoning == nil || *tokens.Reasoning != 30 {
		t.Errorf("expected reasoning 30, got %v", tokens.Reasoning)
	}
	if tokens.CachedRead == nil || *tokens.CachedRead != 40 {
		t.Errorf("expected cachedRead 40, got %v", tokens.CachedRead)
	}
}

func TestExtractProviderTokens_OpenAI(t *testing.T) {
	raw := []byte(`{
		"usage": {
			"prompt_tokens": 150,
			"completion_tokens": 75,
			"total_tokens": 225,
			"prompt_tokens_details": {
				"cached_tokens": 50
			},
			"completion_tokens_details": {
				"reasoning_tokens": 25
			}
		}
	}`)

	tokens, ok := ExtractProviderTokens("openai", contracts.SurfaceOpenAIChat, raw)
	if !ok {
		t.Fatal("expected ExtractProviderTokens to return true")
	}
	if tokens.Input == nil || *tokens.Input != 150 {
		t.Errorf("expected input 150, got %v", tokens.Input)
	}
	if tokens.Output == nil || *tokens.Output != 75 {
		t.Errorf("expected output 75, got %v", tokens.Output)
	}
	if tokens.CachedRead == nil || *tokens.CachedRead != 50 {
		t.Errorf("expected cachedRead 50, got %v", tokens.CachedRead)
	}
	if tokens.Reasoning == nil || *tokens.Reasoning != 25 {
		t.Errorf("expected reasoning 25, got %v", tokens.Reasoning)
	}
}
