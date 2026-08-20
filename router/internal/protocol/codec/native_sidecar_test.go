package codec

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestCaptureNativeSidecarPreservesExactNestedArrayPaths(t *testing.T) {
	body := []byte(`{"model":"gpt-test","messages":[{"role":"user","content":[{"type":"text","text":"one","metadata":{"input":"private-a"}}],"user":{"input":"private-b"}},{"role":"assistant","content":[{"type":"text","text":"two","metadata":{"input":"private-c"}}]}],"vendor":{"user":{"input":"private-d"}}}`)
	encoded := map[string]any{
		"model": "gpt-test",
		"messages": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "one"}}},
			map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "two"}}},
		},
	}
	sidecar, err := CaptureNativeSidecar(contracts.ProtocolOpenAIChat, body, encoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(sidecar.Fields) != 4 {
		t.Fatalf("sidecar fields = %d, want 4", len(sidecar.Fields))
	}
	merged, err := sidecar.ApplySameSurface(contracts.ProtocolOpenAIChat, encoded)
	if err != nil {
		t.Fatal(err)
	}
	got, marshalErr := json.Marshal(merged)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	for _, want := range []string{"private-a", "private-b", "private-c", "private-d"} {
		if !containsJSONString(got, want) {
			t.Fatalf("merged body omitted %q: %s", want, got)
		}
	}
	if sidecar.Fields[0].Path != "/messages/0/content/0/metadata" {
		t.Fatalf("first path = %q", sidecar.Fields[0].Path)
	}
}

func TestNativeSidecarRejectsCrossSurfaceWithoutExplicitMapping(t *testing.T) {
	sidecar := NewNativeSidecar(contracts.ProtocolOpenAIChat)
	if err := sidecar.Add("/messages/0/vendor_extension", json.RawMessage(`{"x":1}`), NativeFieldUnknown); err != nil {
		t.Fatal(err)
	}
	_, err := sidecar.ApplyMapped(contracts.ProtocolOpenAIResponse, map[string]any{"input": []any{}}, nil)
	if err == nil || !errors.Is(err, ErrNativeSidecarUnconsumed) {
		t.Fatalf("cross-surface application error = %v", err)
	}
}

func TestNativeSidecarAppliesOnlyExplicitCrossSurfaceMapping(t *testing.T) {
	sidecar := NewNativeSidecar(contracts.ProtocolOpenAIChat)
	if err := sidecar.Add("/vendor/metadata", json.RawMessage(`{"safe":true}`), NativeFieldProvider); err != nil {
		t.Fatal(err)
	}
	encoded, err := sidecar.ApplyMapped(contracts.ProtocolOpenAIResponse, map[string]any{"input": []any{}, "provider_options": map[string]any{}}, map[JSONPointer]JSONPointer{"/vendor/metadata": "/provider_options/metadata"})
	if err != nil {
		t.Fatal(err)
	}
	providerOptions, ok := encoded["provider_options"].(map[string]any)
	if !ok || providerOptions["metadata"] == nil {
		t.Fatalf("mapped sidecar field missing: %#v", encoded)
	}
}

func TestNativeSidecarRejectsDuplicatePathAndBounds(t *testing.T) {
	sidecar := NewNativeSidecar(contracts.ProtocolOpenAIChat)
	value := json.RawMessage(`1`)
	if err := sidecar.Add("/x", value, NativeFieldUnknown); err != nil {
		t.Fatal(err)
	}
	if err := sidecar.Add("/x", value, NativeFieldUnknown); err == nil || !errors.Is(err, ErrNativeSidecarDuplicate) {
		t.Fatalf("duplicate path error = %v", err)
	}
	deepPath := JSONPointer("/" + repeatString("a/", MaxNativeSidecarPointerDepth) + "a")
	if err := sidecar.Add(deepPath, value, NativeFieldUnknown); err == nil || !errors.Is(err, ErrNativeSidecarPath) {
		t.Fatalf("deep path error = %v", err)
	}
	if err := sidecar.Add("/large", json.RawMessage(`{"large":"`+repeatString("x", MaxNativeSidecarFieldBytes)+`"}`), NativeFieldUnknown); err == nil || !errors.Is(err, ErrNativeSidecarLimit) {
		t.Fatalf("large value error = %v", err)
	}
}

func TestCaptureNativeSidecarRejectsDuplicateJSONKeys(t *testing.T) {
	_, err := CaptureNativeSidecar(contracts.ProtocolOpenAIChat, []byte(`{"model":"gpt","model":"other","messages":[]}`), map[string]any{"model": "gpt", "messages": []any{}})
	if err == nil || !errors.Is(err, ErrNativeSidecar) {
		t.Fatalf("duplicate JSON key error = %v", err)
	}
}

func TestCaptureNativeSidecarRejectsChangedArrayCardinalityWithExtensions(t *testing.T) {
	_, err := CaptureNativeSidecar(contracts.ProtocolOpenAIChat, []byte(`{"model":"gpt","messages":[{"role":"user","content":"one","vendor":{"secret":true}},{"role":"user","content":"two"}]}`), map[string]any{"model": "gpt", "messages": []any{map[string]any{"role": "user", "content": "one"}}})
	if err == nil || !errors.Is(err, ErrNativeSidecarUnconsumed) {
		t.Fatalf("cardinality error = %v", err)
	}
}

func TestCaptureNativeSidecarRejectsChangedArrayIdentityWithExtensions(t *testing.T) {
	body := []byte(`{"model":"gpt","messages":[{"id":"first","role":"user","content":"one","vendor":{"secret":true}},{"id":"second","role":"user","content":"two"}]}`)
	encoded := map[string]any{"model": "gpt", "messages": []any{map[string]any{"id": "second", "role": "user", "content": "two"}, map[string]any{"id": "first", "role": "user", "content": "one"}}}
	_, err := CaptureNativeSidecar(contracts.ProtocolOpenAIChat, body, encoded)
	if err == nil || !errors.Is(err, ErrNativeSidecarUnconsumed) {
		t.Fatalf("identity/order error = %v", err)
	}
}

func TestEncodeNormalizedRequestUsesExactSidecar(t *testing.T) {
	body := []byte(`{"model":"gpt-test","messages":[{"role":"user","content":"hello","vendor":{"input":{"private":true}}}],"metadata":{"user":"private"}}`)
	request, err := NewOpenAIChatRequestDecoder().Decode(context.Background(), body, false)
	if err != nil {
		t.Fatal(err)
	}
	request.Messages[0].Content[0].Text = "changed"
	encoded, err := EncodeNormalizedRequest(context.Background(), contracts.ProtocolOpenAIChat, request, body)
	if err != nil {
		t.Fatal(err)
	}
	if !containsJSONString(encoded, "private") || !containsJSONString(encoded, "changed") {
		t.Fatalf("encoded body lost exact sidecar or canonical change: %s", encoded)
	}
}

func containsJSONString(body []byte, value string) bool {
	return string(body) != "" && string(body) != value && bytesContains(body, []byte(value))
}

func bytesContains(body, value []byte) bool {
	for i := 0; i+len(value) <= len(body); i++ {
		match := true
		for j := range value {
			if body[i+j] != value[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func repeatString(value string, count int) string {
	out := ""
	for range count {
		out += value
	}
	return out
}
