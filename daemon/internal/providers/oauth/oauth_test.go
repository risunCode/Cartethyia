package oauth

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestDefinitionsValidateEveryEntry(t *testing.T) {
	t.Parallel()

	definitions := Definitions()
	if len(definitions) == 0 {
		t.Fatal("Definitions() returned no providers")
	}

	expected := map[string]ProviderDefinition{
		"antigravity": Antigravity(),
		"claude":      ClaudeCode(),
		"cline":       Cline(),
		"clinepass":   ClinePass(),
		"codex":       Codex(),
		"grok-build":  GrokBuild(),
		"kimchi":      Kimchi(),
		"kiro":        Kiro(),
	}
	if len(definitions) != len(expected) {
		t.Fatalf("Definitions() len = %d, want %d", len(definitions), len(expected))
	}

	seen := make(map[string]struct{}, len(definitions))
	for _, def := range definitions {
		validateDefinition(t, def)

		if _, dup := seen[def.ID]; dup {
			t.Fatalf("duplicate provider id %q", def.ID)
		}
		seen[def.ID] = struct{}{}

		want, ok := expected[def.ID]
		if !ok {
			t.Fatalf("unexpected Definitions() entry %q", def.ID)
		}
		if !reflect.DeepEqual(def, want) {
			t.Fatalf("Definitions() entry %q = %#v, want %#v", def.ID, def, want)
		}
	}

	for id := range expected {
		if _, ok := seen[id]; !ok {
			t.Fatalf("Definitions() missing provider %q", id)
		}
	}
}

func TestOAuthProviderCatalogContracts(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name           string
		def            ProviderDefinition
		protocol       string
		adapter        string
		baseURL        string
		authMode       string
		modelsDevID    string
		surfaces       []Surface
		modelIDs       []string
		upstreamByID   map[string]string
		allowedModelID []string
	}{
		{
			name:     "antigravity",
			def:      Antigravity(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterAntigravity),
			baseURL:  "https://daily-cloudcode-pa.googleapis.com",
			surfaces: []Surface{SurfaceOpenAIChat},
			modelIDs: []string{"gemini-3.1-pro", "gemini-3.5-flash", "gemini-3-flash", "claude-sonnet-4-6", "gpt-oss-120b"},
			upstreamByID: map[string]string{
				"gemini-3.1-pro":   "gemini-pro-agent",
				"gemini-3.5-flash": "gemini-3.5-flash-extra-low",
				"gpt-oss-120b":     "gpt-oss-120b-medium",
			},
			allowedModelID: []string{"gemini-3.1-pro", "gemini-3.5-flash", "gemini-3-flash", "claude-sonnet-4-6", "gpt-oss-120b"},
		},
		{
			name:        "claude",
			def:         ClaudeCode(),
			protocol:    string(ProtocolAnthropic),
			adapter:     string(AdapterAnthropic),
			baseURL:     "https://api.anthropic.com/v1",
			authMode:    "bearer",
			modelsDevID: "anthropic",
			modelIDs:    []string{"claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5"},
		},
		{
			name:     "cline",
			def:      Cline(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterOpenAI),
			baseURL:  "https://api.cline.bot/api/v1",
			surfaces: []Surface{SurfaceOpenAIChat},
			modelIDs: []string{
				"deepseek/deepseek-v4-flash",
				"z-ai/glm-5.2",
				"openai/gpt-5.6-sol-pro",
				"openai/gpt-5.6-luna-pro",
				"minimax/minimax-m3",
			},
		},
		{
			name:     "clinepass",
			def:      ClinePass(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterOpenAI),
			baseURL:  "https://api.cline.bot/api/v1",
			surfaces: []Surface{SurfaceOpenAIChat},
			modelIDs: []string{
				"cline-pass/glm-5.2",
				"cline-pass/kimi-k2.7-code",
				"cline-pass/deepseek-v4-pro",
				"cline-pass/minimax-m3",
			},
		},
		{
			name:     "codex",
			def:      Codex(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterCodex),
			baseURL:  "https://chatgpt.com/backend-api",
			surfaces: []Surface{SurfaceOpenAIResponses},
			modelIDs: []string{
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.6-luna",
				"gpt-5.5",
				"gpt-5.4",
				"gpt-5.3-codex-spark",
			},
		},
		{
			name:     "grok-build",
			def:      GrokBuild(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterGrok),
			baseURL:  "https://cli-chat-proxy.grok.com/v1",
			surfaces: []Surface{SurfaceOpenAIResponses},
			modelIDs: []string{
				"grok-4.20-0309-reasoning",
				"grok-4.20-0309-non-reasoning",
				"grok-4.20-multi-agent-0309",
				"grok-4.5",
			},
		},
		{
			name:     "kimchi",
			def:      Kimchi(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterOpenAI),
			baseURL:  "https://llm.kimchi.dev/openai/v1",
			surfaces: []Surface{SurfaceOpenAIChat},
			modelIDs: []string{
				"kimi-k2.7",
				"minimax-m3",
				"deepseek-v4-flash",
				"nemotron-3-ultra-fp4",
			},
		},
		{
			name:     "kiro",
			def:      Kiro(),
			protocol: string(ProtocolOpenAI),
			adapter:  string(AdapterOpenAI),
			baseURL:  "https://runtime.us-east-1.kiro.dev",
			surfaces: []Surface{SurfaceOpenAIChat},
			modelIDs: []string{
				"claude-opus-4.8",
				"claude-sonnet-5",
				"auto",
				"deepseek-3.2",
				"qwen3-coder-next",
				"glm-5",
				"gpt-5.6-sol",
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			validateDefinition(t, tc.def)

			if tc.def.ID != tc.name {
				t.Fatalf("ID = %q, want %q", tc.def.ID, tc.name)
			}
			if string(tc.def.Protocol) != tc.protocol {
				t.Fatalf("Protocol = %q, want %q", tc.def.Protocol, tc.protocol)
			}
			if string(tc.def.Adapter) != tc.adapter {
				t.Fatalf("Adapter = %q, want %q", tc.def.Adapter, tc.adapter)
			}
			if tc.def.BaseURL != tc.baseURL {
				t.Fatalf("BaseURL = %q, want %q", tc.def.BaseURL, tc.baseURL)
			}
			if tc.def.AuthMode != tc.authMode {
				t.Fatalf("AuthMode = %q, want %q", tc.def.AuthMode, tc.authMode)
			}
			if tc.def.ModelsDevID != tc.modelsDevID {
				t.Fatalf("ModelsDevID = %q, want %q", tc.def.ModelsDevID, tc.modelsDevID)
			}
			if !reflect.DeepEqual(tc.def.Surfaces, tc.surfaces) {
				t.Fatalf("Surfaces = %#v, want %#v", tc.def.Surfaces, tc.surfaces)
			}
			if !reflect.DeepEqual(tc.def.Overrides.AllowedModelIDs, tc.allowedModelID) {
				t.Fatalf("AllowedModelIDs = %#v, want %#v", tc.def.Overrides.AllowedModelIDs, tc.allowedModelID)
			}

			gotIDs := make([]string, 0, len(tc.def.Models))
			for _, model := range tc.def.Models {
				gotIDs = append(gotIDs, model.ID)
				wantUpstream, hasUpstream := tc.upstreamByID[model.ID]
				if hasUpstream {
					if model.UpstreamID != wantUpstream {
						t.Fatalf("model %q UpstreamID = %q, want %q", model.ID, model.UpstreamID, wantUpstream)
					}
					continue
				}
				if model.UpstreamID != "" {
					t.Fatalf("model %q unexpected UpstreamID %q", model.ID, model.UpstreamID)
				}
			}
			if !reflect.DeepEqual(gotIDs, tc.modelIDs) {
				t.Fatalf("model IDs = %#v, want %#v", gotIDs, tc.modelIDs)
			}
		})
	}
}

func validateDefinition(t *testing.T, def ProviderDefinition) {
	t.Helper()

	id := strings.TrimSpace(def.ID)
	if id == "" {
		t.Fatal("provider definition has empty ID")
	}
	if def.ID != id {
		t.Fatalf("provider %q ID has surrounding whitespace", def.ID)
	}
	if strings.TrimSpace(def.DisplayName) == "" {
		t.Fatalf("provider %q has empty DisplayName", def.ID)
	}
	if def.CredentialKind != CredentialOAuth {
		t.Fatalf("provider %q CredentialKind = %q, want %q", def.ID, def.CredentialKind, CredentialOAuth)
	}
	if def.Protocol != ProtocolOpenAI && def.Protocol != ProtocolAnthropic {
		t.Fatalf("provider %q Protocol = %q, unsupported", def.ID, def.Protocol)
	}
	switch def.Adapter {
	case AdapterOpenAI, AdapterAnthropic, AdapterGrok, AdapterCodex, AdapterAntigravity:
	default:
		t.Fatalf("provider %q Adapter = %q, unsupported", def.ID, def.Adapter)
	}
	if strings.TrimSpace(def.BaseURL) == "" {
		t.Fatalf("provider %q has empty BaseURL", def.ID)
	}
	parsed, err := url.Parse(def.BaseURL)
	if err != nil {
		t.Fatalf("provider %q BaseURL parse error: %v", def.ID, err)
	}
	if parsed.Scheme != "https" {
		t.Fatalf("provider %q BaseURL scheme = %q, want https", def.ID, parsed.Scheme)
	}
	if parsed.Host == "" {
		t.Fatalf("provider %q BaseURL missing host", def.ID)
	}
	if len(def.Models) == 0 {
		t.Fatalf("provider %q has no models", def.ID)
	}

	seenModels := make(map[string]struct{}, len(def.Models))
	for _, model := range def.Models {
		modelID := strings.TrimSpace(model.ID)
		if modelID == "" {
			t.Fatalf("provider %q has a model with empty ID", def.ID)
		}
		if model.ID != modelID {
			t.Fatalf("provider %q model %q ID has surrounding whitespace", def.ID, model.ID)
		}
		if strings.TrimSpace(model.DisplayName) == "" {
			t.Fatalf("provider %q model %q has empty DisplayName", def.ID, model.ID)
		}
		if _, dup := seenModels[model.ID]; dup {
			t.Fatalf("provider %q has duplicate model id %q", def.ID, model.ID)
		}
		seenModels[model.ID] = struct{}{}
	}

	for _, allowed := range def.Overrides.AllowedModelIDs {
		if _, ok := seenModels[allowed]; !ok {
			t.Fatalf("provider %q AllowedModelIDs references missing model %q", def.ID, allowed)
		}
	}
}
