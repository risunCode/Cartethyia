package policies

import (
	"testing"
)

func TestPolicyKnownIDs(t *testing.T) {
	t.Parallel()

	cases := []struct {
		id   string
		want ProviderPolicy
	}{
		{id: "claude", want: ClaudeCode},
		{id: "antigravity", want: Antigravity},
		{id: "codex", want: Codex},
		{id: "grok-build", want: GrokBuild},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.id, func(t *testing.T) {
			t.Parallel()

			got, ok := Policy(tc.id)
			if !ok {
				t.Fatalf("Policy(%q) returned ok=false", tc.id)
			}
			if got.ID != tc.want.ID {
				t.Fatalf("ID: got %q want %q", got.ID, tc.want.ID)
			}
			if got.UserAgent != tc.want.UserAgent {
				t.Fatalf("UserAgent: got %q want %q", got.UserAgent, tc.want.UserAgent)
			}
			if got.SystemPrompt != tc.want.SystemPrompt {
				t.Fatalf("SystemPrompt: got %q want %q", got.SystemPrompt, tc.want.SystemPrompt)
			}
			if got.SessionScoped != tc.want.SessionScoped {
				t.Fatalf("SessionScoped: got %v want %v", got.SessionScoped, tc.want.SessionScoped)
			}
			if got.PromptCacheKey != tc.want.PromptCacheKey {
				t.Fatalf("PromptCacheKey: got %v want %v", got.PromptCacheKey, tc.want.PromptCacheKey)
			}
			if got.Headers != nil {
				t.Fatalf("Headers: got %#v want nil", got.Headers)
			}
		})
	}
}

func TestPolicyUnknownID(t *testing.T) {
	t.Parallel()

	got, ok := Policy("unknown-provider")
	if ok {
		t.Fatalf("Policy(unknown) returned ok=true with %#v", got)
	}
	if got.ID != "" || got.UserAgent != "" || got.SystemPrompt != "" || got.Headers != nil || got.SessionScoped || got.PromptCacheKey {
		t.Fatalf("Policy(unknown) returned non-zero policy: %#v", got)
	}
}

func TestCloneHeaders(t *testing.T) {
	t.Parallel()

	if got := cloneHeaders(nil); got != nil {
		t.Fatalf("cloneHeaders(nil) = %#v, want nil", got)
	}
	if got := cloneHeaders(map[string]string{}); got != nil {
		t.Fatalf("cloneHeaders(empty) = %#v, want nil", got)
	}

	src := map[string]string{"X-Test": "original", "X-Other": "value"}
	got := cloneHeaders(src)
	if got["X-Test"] != "original" || got["X-Other"] != "value" {
		t.Fatalf("cloneHeaders copy mismatch: %#v", got)
	}

	got["X-Test"] = "mutated"
	got["X-Extra"] = "added"
	if src["X-Test"] != "original" {
		t.Fatalf("source map was mutated: %#v", src)
	}
	if _, exists := src["X-Extra"]; exists {
		t.Fatalf("source map gained unexpected key: %#v", src)
	}
}
