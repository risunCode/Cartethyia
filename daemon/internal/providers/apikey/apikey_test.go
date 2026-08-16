package apikey

import (
	"strings"
	"testing"
)

func TestDefinitionsRequiredFields(t *testing.T) {
	t.Parallel()

	definitions := Definitions()
	if len(definitions) == 0 {
		t.Fatal("Definitions() returned no providers")
	}

	seen := make(map[string]struct{}, len(definitions))
	for _, def := range definitions {
		def := def
		name := strings.TrimSpace(def.ID)
		if name == "" {
			name = "<empty-id>"
		}

		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if strings.TrimSpace(def.ID) == "" {
				t.Fatal("ID is required")
			}
			if strings.TrimSpace(def.DisplayName) == "" {
				t.Fatal("DisplayName is required")
			}
			if def.Protocol == "" {
				t.Fatal("Protocol is required")
			}
			if def.Adapter == "" {
				t.Fatal("Adapter is required")
			}
			if def.CredentialKind == "" {
				t.Fatal("CredentialKind is required")
			}
			switch def.CredentialKind {
			case CredentialAPIKey, CredentialNone:
			default:
				t.Fatalf("CredentialKind = %q, want api_key or none", def.CredentialKind)
			}
			if strings.TrimSpace(def.BaseURL) == "" {
				t.Fatal("BaseURL is required")
			}
			if len(def.Models) == 0 {
				t.Fatal("Models is required")
			}
			for i, model := range def.Models {
				if strings.TrimSpace(model.ID) == "" {
					t.Fatalf("Models[%d].ID is required", i)
				}
			}
		})

		if _, dup := seen[def.ID]; dup {
			t.Fatalf("duplicate provider ID %q", def.ID)
		}
		seen[def.ID] = struct{}{}
	}
}

func TestOpenAIProviderHelper(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		id          string
		displayName string
		baseURL     string
		modelsDevID string
		models      [][]ProviderModel
		wantModels  int
	}{
		{
			name:        "without_fallback_models",
			id:          "helper-empty",
			displayName: "Helper Empty",
			baseURL:     "https://example.test/v1",
			modelsDevID: "helper-empty",
			wantModels:  0,
		},
		{
			name:        "with_fallback_models",
			id:          "helper-models",
			displayName: "Helper Models",
			baseURL:     "https://example.test/v1",
			modelsDevID: "helper-models",
			models:      [][]ProviderModel{{Model("demo", "Demo", nil)}},
			wantModels:  1,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := openAIProvider(tc.id, tc.displayName, tc.baseURL, tc.modelsDevID, tc.models...)
			if got.ID != tc.id {
				t.Fatalf("ID = %q, want %q", got.ID, tc.id)
			}
			if got.DisplayName != tc.displayName {
				t.Fatalf("DisplayName = %q, want %q", got.DisplayName, tc.displayName)
			}
			if got.Protocol != ProtocolOpenAI {
				t.Fatalf("Protocol = %q, want %q", got.Protocol, ProtocolOpenAI)
			}
			if got.Adapter != AdapterOpenAI {
				t.Fatalf("Adapter = %q, want %q", got.Adapter, AdapterOpenAI)
			}
			if got.CredentialKind != CredentialAPIKey {
				t.Fatalf("CredentialKind = %q, want %q", got.CredentialKind, CredentialAPIKey)
			}
			if got.BaseURL != tc.baseURL {
				t.Fatalf("BaseURL = %q, want %q", got.BaseURL, tc.baseURL)
			}
			if got.ModelsDevID != tc.modelsDevID {
				t.Fatalf("ModelsDevID = %q, want %q", got.ModelsDevID, tc.modelsDevID)
			}
			if len(got.Surfaces) != 1 || got.Surfaces[0] != SurfaceOpenAIChat {
				t.Fatalf("Surfaces = %#v, want OpenAI Chat only", got.Surfaces)
			}
			if len(got.Models) != tc.wantModels {
				t.Fatalf("Models len = %d, want %d", len(got.Models), tc.wantModels)
			}
		})
	}
}
