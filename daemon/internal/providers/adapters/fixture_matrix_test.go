package adapters

import (
	"bytes"
	"errors"
	"net/http"
	"testing"
)

type providerFixture struct {
	name        string
	adapter     Provider
	model       string
	surface     Surface
	unsupported Surface
}

func providerFixtures() []providerFixture {
	openAICaps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIResponses, SurfaceImages}, Streaming: true, ToolCalls: true, Images: true}
	compatibleCaps := ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, ToolCalls: true}
	return []providerFixture{
		{name: "openai", adapter: NewOpenAIAdapter(OpenAIAdapterConfig{Models: []ProviderModel{Model("fixture-openai", "Fixture OpenAI", &openAICaps)}}), model: "fixture-openai", surface: SurfaceOpenAIResponses, unsupported: SurfaceAnthropicMessages},
		{name: "anthropic", adapter: NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("fixture-anthropic", "Fixture Anthropic", nil)}}), model: "fixture-anthropic", surface: SurfaceAnthropicMessages, unsupported: SurfaceOpenAIChat},

		{name: "openai-compatible", adapter: NewOpenAIAdapter(OpenAIAdapterConfig{ID: "fixture-compatible", Surfaces: []Surface{SurfaceOpenAIChat}, Models: []ProviderModel{Model("fixture-compatible", "Fixture Compatible", &compatibleCaps)}}), model: "fixture-compatible", surface: SurfaceOpenAIChat, unsupported: SurfaceAnthropicMessages},
	}
}

func TestProviderFixtureMatrixClassifiesDeterministicFailures(t *testing.T) {
	t.Parallel()
	statuses := []struct {
		name     string
		status   int
		category ResponseCategory
		retry    bool
	}{
		{name: "authentication", status: http.StatusUnauthorized, category: CategoryAuth, retry: true},
		{name: "rate-limit", status: http.StatusTooManyRequests, category: CategoryRateLimit, retry: true},
		{name: "quota", status: http.StatusPaymentRequired, category: CategoryQuota},
		{name: "context-overflow", status: 0, category: CategoryFatal},
	}
	for _, fixture := range providerFixtures() {
		fixture := fixture
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			for _, tc := range statuses {
				tc := tc
				t.Run(tc.name, func(t *testing.T) {
					t.Parallel()
					body := []byte(`{"error":"` + tc.name + `"}`)
					if tc.name == "context-overflow" {
						body = []byte(`{"error":"context_overflow"}`)
					}
					classified := fixture.adapter.ClassifyResponse(NewResponseEvidence(tc.status, nil, body))
					if classified.Category != tc.category || classified.Retryable != tc.retry {
						t.Fatalf("status=%d category=%q retry=%v, want category=%q retry=%v", tc.status, classified.Category, classified.Retryable, tc.category, tc.retry)
					}
				})
			}
		})
	}
}

func TestProviderFixtureMatrixAuthenticationAndIdentityHeaders(t *testing.T) {
	t.Parallel()
	for _, fixture := range providerFixtures() {
		fixture := fixture
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			target, err := fixture.adapter.ResolveTarget(fixture.model, fixture.surface)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.adapter.AuthMaterial("", target); err == nil {
				t.Fatal("empty credential accepted")
			} else {
				var authErr *AuthError
				if !errors.As(err, &authErr) {
					t.Fatalf("empty credential error category=%T, want *AuthError", err)
				}
			}
			built, err := fixture.adapter.BuildRequest(RequestEnvelope{Target: target, Body: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`), Stream: true}, "fixture-secret")
			if err != nil {
				t.Fatal(err)
			}
			if fixture.name != "agentrouter" && built.Auth.Headers.Get("User-Agent") != "" {
				t.Fatalf("product identity leaked in User-Agent: %q", built.Auth.Headers.Get("User-Agent"))
			}
			if fixture.name == "agentrouter" && built.Auth.Headers.Get("User-Agent") != "claude-cli/2.1.195 (external, sdk-cli)" {
				t.Fatalf("AgentRouter identity User-Agent = %q", built.Auth.Headers.Get("User-Agent"))
			}
			if got := built.Auth.Headers.Get("Authorization"); got != "" && fixture.name == "anthropic" {
				t.Fatalf("Anthropic fixture unexpectedly used Authorization: %q", got)
			}
			if bytes.Contains(built.Body, []byte("fixture-secret")) {
				t.Fatal("credential leaked into request body")
			}
			if got := built.Auth.Headers.Get("x-api-key"); got != "" && fixture.name != "anthropic" && fixture.name != "agentrouter" {
				t.Fatalf("non-Anthropic fixture unexpectedly used x-api-key: %q", got)
			}
			if fixture.name == "agentrouter" {
				for _, header := range []string{"x-app", "x-stainless-lang", "x-claude-code-session-id", "x-api-key"} {
					if built.Auth.Headers.Get(header) == "" {
						t.Fatalf("AgentRouter identity header %q missing", header)
					}
				}
			}
		})
	}
}

func TestProviderFixtureMatrixCapabilityRejection(t *testing.T) {
	t.Parallel()
	for _, fixture := range providerFixtures() {
		fixture := fixture
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			_, err := fixture.adapter.ResolveTarget(fixture.model, fixture.unsupported)
			if err == nil {
				t.Fatal("unsupported surface accepted")
			}
			var unsupported *UnknownSurfaceError
			if !errors.As(err, &unsupported) {
				t.Fatalf("capability rejection category=%T, want *UnknownSurfaceError", err)
			}
		})
	}
}

func TestAnthropicFixtureMalformedBodyHasStableCode(t *testing.T) {
	t.Parallel()
	adapter := NewAnthropicAdapter(AnthropicAdapterConfig{Models: []ProviderModel{Model("fixture-anthropic", "Fixture Anthropic", nil)}})
	target, err := adapter.ResolveTarget("fixture-anthropic", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.BuildRequest(RequestEnvelope{Target: target, Body: []byte(`{"model":`), Stream: false}, "fixture-secret")
	var coded *AnthropicAdapterError
	if !errors.As(err, &coded) || coded.Code != AnthropicErrorInvalidRequest {
		t.Fatalf("malformed body code=%q error=%v", codedCode(coded), err)
	}
}
