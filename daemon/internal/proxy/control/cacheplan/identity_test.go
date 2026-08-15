package cacheplan

import "testing"

func TestApplyPromptCacheIdentityIsStableAndOpaque(t *testing.T) {
	payload := map[string]any{"model": "gpt-5", "instructions": "stable", "input": []any{"hello"}}
	first, ok := ApplyPromptCacheIdentity(payload, "openai-responses", "openai", "gpt-5", true)
	if !ok || first == "" {
		t.Fatal("missing stable prefix")
	}
	key, ok := payload["prompt_cache_key"].(string)
	if !ok || key == "" {
		t.Fatal("missing prompt cache key")
	}
	if key == "stable" || key == "hello" {
		t.Fatalf("cache key leaked content: %q", key)
	}
	second, ok := ApplyPromptCacheIdentity(payload, "openai-responses", "openai", "gpt-5", true)
	if !ok || string(first) != string(second) {
		t.Fatal("cache identity is not deterministic")
	}
}
