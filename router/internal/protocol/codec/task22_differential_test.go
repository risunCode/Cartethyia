package codec

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// task22SemanticDigest intentionally projects only canonical meaning. It is
// independent of wire JSON order, provider wrappers, and generated IDs.
func task22SemanticDigest(req *NormalizedRequest) string {
	if req == nil {
		return ""
	}
	type block struct {
		Type        ContentBlockType
		Text        string
		ToolKind    ToolKind
		ToolName    string
		ToolID      string
		Arguments   string
		Result      string
		ResultError bool
		MediaKind   MediaKind
		Reference   ReferenceKind
		MediaValue  string
		MIME        string
		Detail      ImageDetail
	}
	type message struct {
		Role   Role
		Blocks []block
	}
	view := struct {
		Model    string
		Messages []message
		Tools    []struct {
			Name string
			Kind ToolKind
		}
		Reasoning ReasoningFlag
		Stream    bool
	}{Model: req.Model, Reasoning: req.Reasoning, Stream: req.Stream}
	for _, msg := range req.Messages {
		m := message{Role: msg.Role}
		for _, content := range msg.Content {
			b := block{Type: content.Type, Text: content.Text, ToolKind: content.ToolKind, ToolName: content.ToolName, ToolID: content.ToolCallID, Arguments: content.ToolArguments, Result: content.ToolResult, ResultError: content.ToolResultIsError}
			if content.Media != nil {
				b.MediaKind, b.Reference, b.MediaValue, b.MIME, b.Detail = content.Media.Media, content.Media.Reference, content.Media.Value, content.Media.MIMEType, content.Media.Detail
			}
			if content.Image != nil {
				b.MediaKind, b.Reference, b.MediaValue, b.MIME, b.Detail = MediaImage, ReferenceURL, content.Image.Value, content.Image.MediaType, content.Image.Detail
			}
			m.Blocks = append(m.Blocks, b)
		}
		view.Messages = append(view.Messages, m)
	}
	for _, tool := range req.Tools {
		view.Tools = append(view.Tools, struct {
			Name string
			Kind ToolKind
		}{tool.Name, tool.Kind})
	}
	body, _ := json.Marshal(view)
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func task22SurfaceBody(surface contracts.Protocol) []byte {
	switch surface {
	case contracts.ProtocolOpenAIChat:
		return []byte(`{"model":"fixture-model","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`)
	case contracts.ProtocolOpenAIResponse:
		return []byte(`{"model":"fixture-model","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`)
	case contracts.ProtocolAnthropic:
		return []byte(`{"model":"fixture-model","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`)
	case contracts.ProtocolGemini:
		return []byte(`{"model":"fixture-model","contents":[{"role":"user","parts":[{"text":"hello"}]}]}`)
	default:
		return nil
	}
}

func TestTask22SemanticDifferentialEveryRepresentableSurfacePair(t *testing.T) {
	ctx := context.Background()
	reg := NewDefaultRegistry()
	surfaces := []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponse, contracts.ProtocolAnthropic, contracts.ProtocolGemini}
	for _, source := range surfaces {
		sourceDecoder, ok := reg.LookupDecoder(source)
		if !ok {
			t.Fatalf("source decoder missing for %s", source)
		}
		sourceReq, err := sourceDecoder.Decode(ctx, task22SurfaceBody(source), false)
		if err != nil {
			t.Fatalf("decode source %s: %v", source, err)
		}
		want := task22SemanticDigest(sourceReq)
		for _, target := range surfaces {
			targetEncoder, ok := reg.LookupRequest(target)
			if !ok {
				t.Fatalf("target encoder missing for %s", target)
			}
			encoded, encodeErr := targetEncoder.Encode(ctx, sourceReq)
			if encodeErr != nil {
				t.Fatalf("encode %s -> %s: %v", source, target, encodeErr)
			}
			wire, marshalErr := json.Marshal(encoded.Wire)
			if marshalErr != nil {
				t.Fatalf("marshal %s -> %s: %v", source, target, marshalErr)
			}
			targetDecoder, ok := reg.LookupDecoder(target)
			if !ok {
				t.Fatalf("target decoder missing for %s", target)
			}
			gotReq, decodeErr := targetDecoder.Decode(ctx, wire, false)
			if decodeErr != nil {
				t.Fatalf("decode %s output from %s: %v", target, source, decodeErr)
			}
			if got := task22SemanticDigest(gotReq); got != want {
				t.Fatalf("semantic mismatch %s -> %s: got=%s want=%s", source, target, got, want)
			}
		}
	}
}

func TestTask22SanitizedIndependentFixturesAreBoundedAndSecretFree(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "testdata")
	fixtures := []string{
		"task22-9router-tool-orphans.json", "task22-9router-modality-cache.json", "task22-9router-text-reasoning-terminal.json",
		"task22-ohmypi-compaction-v1.json", "task22-ohmypi-compaction-v2.json", "task22-ohmypi-tool-history-media-timeout.json",
	}
	for _, name := range fixtures {
		body, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if len(body) == 0 || len(body) > 64*1024 {
			t.Fatalf("fixture %s size out of bounds: %d", name, len(body))
		}
		var value map[string]any
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatalf("fixture %s invalid JSON: %v", name, err)
		}
		if value["fixture_id"] == nil || value["source"] == nil || value["target"] == nil || value["expectation"] == nil {
			t.Fatalf("fixture %s missing independent semantic envelope", name)
		}
		if _, ok := value["messages"]; strings.HasPrefix(name, "task22-9router-") && !ok {
			t.Fatalf("fixture %s missing message semantics", name)
		}
		if strings.HasPrefix(name, "task22-ohmypi-compaction-") && value["operation"] != "compact" {
			t.Fatalf("fixture %s missing compact operation", name)
		}
		for _, forbidden := range []string{"sk_live_", "Bearer ", "-----BEGIN", "api_key", "prompt-content"} {
			if strings.Contains(string(body), forbidden) {
				t.Fatalf("fixture %s unexpectedly contains sentinel %q", name, forbidden)
			}
		}
	}
}

func TestTask22NilAndInvalidTransformBoundaries(t *testing.T) {
	ctx := context.Background()
	if _, err := NewCompactionRequest(CompactionRequestInput{}); err == nil || err.Code != CodeInvalidCompaction {
		t.Fatalf("invalid compaction err=%v", err)
	}
	if _, err := EncodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, nil); err == nil || err.Code != CodeInvalidCompaction {
		t.Fatalf("nil compaction err=%v", err)
	}
	if _, err := DecodeCompactionRequest(ctx, contracts.ProtocolOpenAIResponse, []byte(`{}`), 99, false); err == nil || err.Code != CodeInvalidCompaction {
		t.Fatalf("invalid version err=%v", err)
	}
	if err := (*NormalizedRequest)(nil).Validate(); err == nil {
		t.Fatal("nil request unexpectedly validated")
	}
	if _, err := NewMediaReference(MediaImage, ReferenceURL, "", MediaReferenceOptions{}); err == nil || err.Code != CodeInvalidMediaReference {
		t.Fatalf("invalid media err=%v", err)
	}
	if _, err := NewToolOccurrenceLedger(nil); err != nil {
		t.Fatalf("nil empty ledger should remain constructible: %v", err)
	}
	for _, encoder := range []ResponseEncoder{NewOpenAIChatResponseEncoder(), NewOpenAIResponsesResponseEncoder(), NewAnthropicMessagesResponseEncoder(), NewGeminiResponseEncoder()} {
		if _, err := encoder.Encode(ctx, nil); err == nil {
			t.Fatalf("%s accepted nil response", encoder.Protocol())
		}
		if _, err := encoder.EncodeEvent(ctx, nil); err == nil {
			t.Fatalf("%s accepted nil event", encoder.Protocol())
		}
	}
}
