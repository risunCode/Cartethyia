package builtin

import (
	"reflect"
	"testing"
)

func TestNativeAPIKeyDefinitionsOwnSeparateSurfaces(t *testing.T) {
	openai := OpenAI()
	if openai.ID != "openai" {
		t.Fatalf("OpenAI definition ID = %q", openai.ID)
	}
	if !reflect.DeepEqual(openai.Surfaces, []Surface{SurfaceOpenAIResponses}) {
		t.Fatalf("OpenAI surfaces = %#v, want Responses only", openai.Surfaces)
	}
	for _, model := range openai.Models {
		if model.Capabilities == nil {
			t.Fatalf("OpenAI model %q has nil capabilities", model.ID)
		}
		if !reflect.DeepEqual(model.Capabilities.Surfaces, []Surface{SurfaceOpenAIResponses}) {
			t.Fatalf("OpenAI model %q surfaces = %#v, want Responses only", model.ID, model.Capabilities.Surfaces)
		}
	}

	anthropic := AnthropicAI()
	if anthropic.ID != "anthropic" {
		t.Fatalf("Anthropic definition ID = %q", anthropic.ID)
	}
	for _, model := range anthropic.Models {
		if model.Capabilities == nil {
			t.Fatalf("Anthropic model %q has nil capabilities", model.ID)
		}
		if !reflect.DeepEqual(model.Capabilities.Surfaces, []Surface{SurfaceAnthropicMessages}) {
			t.Fatalf("Anthropic model %q surfaces = %#v, want Anthropic Messages only", model.ID, model.Capabilities.Surfaces)
		}
	}
}
