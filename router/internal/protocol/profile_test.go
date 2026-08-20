package protocol

import (
	"context"
	"net/http"
	"testing"
)

func TestClassifyUsesWireSurfaceOverConflictingHints(t *testing.T) {
	profile, err := Classify(ClassificationInput{
		Endpoint: "/v1/responses",
		Surface:  SurfaceOpenAIResponses,
		Headers: http.Header{
			"User-Agent": []string{"claude-code/1.0"},
		},
		Body: []byte(`{"model":"gpt-5","input":[{"role":"user","content":"hi"}]}`),
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if profile.ID != ProfileUnknownStandard {
		t.Fatalf("profile = %q, want unknown-standard after conflicting hint", profile.ID)
	}
	if profile.Surface != SurfaceOpenAIResponses {
		t.Fatalf("surface = %q, want %q", profile.Surface, SurfaceOpenAIResponses)
	}
	if len(profile.Ambiguities) == 0 {
		t.Fatal("expected bounded ambiguity for conflicting header")
	}
}

func TestClassifyRecognizesNativeGeminiShape(t *testing.T) {
	profile, err := Classify(ClassificationInput{
		Endpoint: "/v1beta/models/gemini:generateContent",
		Surface:  SurfaceGemini,
		Body:     []byte(`{"contents":[{"parts":[{"text":"hi"}]}]}`),
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if profile.ID != ProfileGeminiCLI {
		t.Fatalf("profile = %q, want %q", profile.ID, ProfileGeminiCLI)
	}
}

func TestAttachProfilePreservesUnknownInboundContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attached, err := AttachProfile(ctx, ClassificationInput{
		Endpoint: "/v1/chat/completions",
		Surface:  SurfaceOpenAIChat,
		Body:     []byte(`{"model":"gpt-5","messages":[{"role":"user","content":"hi"}]}`),
	})
	if err != nil {
		t.Fatalf("AttachProfile() error = %v", err)
	}
	if attached != ctx {
		t.Fatal("unknown-standard profile must preserve inbound context identity")
	}
	cancel()
	if attached.Err() != context.Canceled {
		t.Fatalf("context error = %v, want %v", attached.Err(), context.Canceled)
	}
}
