package providers

import "testing"

func TestLoadModelsDevModels(t *testing.T) {
	for _, id := range []string{"openai", "anthropic", "deepseek", "xiaomi"} {
		models := LoadModelsDevModels(id, []Surface{SurfaceOpenAIChat})
		if len(models) == 0 {
			t.Fatalf("provider %q returned no models", id)
		}
	}
}
