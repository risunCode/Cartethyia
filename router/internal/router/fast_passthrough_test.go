package router

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestIsSameSurface(t *testing.T) {
	tests := []struct {
		source    contracts.Surface
		target    contracts.Surface
		wantEqual bool
	}{
		{contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIChat, true},
		{contracts.SurfaceOpenAIChat, contracts.SurfaceAnthropic, false},
		{contracts.SurfaceAnthropic, contracts.SurfaceAnthropic, true},
		{contracts.SurfaceGemini, contracts.SurfaceGemini, true},
		{contracts.SurfaceWebSearch, contracts.SurfaceImages, false},
	}

	for _, tt := range tests {
		got := IsSameSurface(tt.source, tt.target)
		if got != tt.wantEqual {
			t.Errorf("IsSameSurface(%q, %q) = %v, want %v", tt.source, tt.target, got, tt.wantEqual)
		}
	}
}

func TestPrepareSameSurfaceRequestPassPreservesOriginalBytes(t *testing.T) {
	body := []byte("{\n  \"model\": \"gpt-4o\",\n  \"messages\": [{\"role\":\"user\",\"content\":\"hello\"}],\n  \"x-vendor\": {\"keep\": [1, true, null]}\n}\n")
	prepared, err := PrepareSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "gpt-4o", body)
	if err != nil {
		t.Fatalf("PrepareSameSurfaceRequest returned error: %v", err)
	}
	if prepared.Patched || prepared.Mode != contracts.ModePass {
		t.Fatal("expected PASS preparation, got PATCH")
	}
	if !bytes.Equal(prepared.Body, body) {
		t.Fatalf("PASS changed request bytes:\n got %q\nwant %q", prepared.Body, body)
	}
	body[0] = '!'
	if prepared.Body[0] == '!' {
		t.Fatal("prepared body aliases caller buffer")
	}
}

func TestPrepareSameSurfaceRequestPatchPreservesUnknownFields(t *testing.T) {
	body := []byte(`{"model":"gpt-4o(high)","messages":[{"role":"user","content":"hello","x-unknown":{"nested":true}}],"x-vendor":"keep"}`)
	prepared, err := PrepareSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "gpt-4o(high)", body)
	if err != nil {
		t.Fatalf("PrepareSameSurfaceRequest returned error: %v", err)
	}
	if !prepared.Patched || prepared.Mode != contracts.ModePatch || prepared.Model != "gpt-4o" {
		t.Fatalf("expected PATCH with cleaned model, got %+v", prepared)
	}
	var payload struct {
		Model    string           `json:"model"`
		Messages []map[string]any `json:"messages"`
		Vendor   string           `json:"x-vendor"`
	}
	if err := json.Unmarshal(prepared.Body, &payload); err != nil {
		t.Fatalf("patched body is invalid JSON: %v", err)
	}
	if payload.Model != "gpt-4o" || payload.Vendor != "keep" {
		t.Fatalf("known/unknown fields not preserved: %+v", payload)
	}
	if payload.Messages[0]["x-unknown"].(map[string]any)["nested"] != true {
		t.Fatalf("nested unknown field was not preserved: %+v", payload.Messages[0])
	}
}

func TestPrepareSameSurfaceRequestRejectsInvalidOrUnboundedEnvelope(t *testing.T) {
	for _, body := range [][]byte{nil, []byte(`{`), []byte(`[]`), []byte(`{}`)} {
		if _, err := PrepareSameSurfaceRequest(context.Background(), contracts.SurfaceOpenAIChat, "", body); err == nil {
			t.Fatalf("expected preparation error for body %q", body)
		}
	}
}

func BenchmarkPrepareSameSurfaceRequestPass(b *testing.B) {
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}],"x-vendor":{"opaque":true}}`)
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		prepared, err := PrepareSameSurfaceRequest(ctx, contracts.SurfaceOpenAIChat, "gpt-4o", body)
		if err != nil {
			b.Fatal(err)
		}
		if prepared.Patched || prepared.Mode != contracts.ModePass || !bytes.Equal(prepared.Body, body) {
			b.Fatal("PASS preparation changed request")
		}
	}
}

func BenchmarkPrepareSameSurfaceRequestPatch(b *testing.B) {
	body := []byte(`{"model":"gpt-4o(high)","messages":[{"role":"user","content":"hello"}],"x-vendor":{"opaque":true}}`)
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		prepared, err := PrepareSameSurfaceRequest(ctx, contracts.SurfaceOpenAIChat, "gpt-4o(high)", body)
		if err != nil {
			b.Fatal(err)
		}
		if !prepared.Patched || prepared.Mode != contracts.ModePatch || prepared.Model != "gpt-4o" {
			b.Fatal("PATCH preparation did not update model")
		}
	}
}
