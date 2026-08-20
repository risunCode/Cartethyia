package codec

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func FuzzRequestTransforms(f *testing.F) {
	const secretSentinel = "credential-SENTINEL-request-transform"
	seeds := []struct {
		surface uint8
		stream  bool
		body    []byte
	}{
		{surface: 0, body: []byte(`{"model":"gpt","messages":[{"role":"user","content":"hello"}]}`)},
		{surface: 0, stream: true, body: []byte(`{"model":"gpt","messages":[{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}]}`)},
		{surface: 1, body: []byte(`{"model":"gpt","input":"hello"}`)},
		{surface: 1, stream: true, body: []byte(`{"model":"gpt","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}`)},
		{surface: 2, body: []byte(`{"model":"claude","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`)},
		{surface: 2, stream: true, body: []byte(`{"model":"claude","max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`)},
		{surface: 0, body: []byte(`{"model":"gpt","messages":{},"metadata":{"secret":"` + secretSentinel + `"}}`)},
	}
	for _, seed := range seeds {
		f.Add(seed.surface, seed.stream, seed.body)
	}
	pipeline, err := NewDefaultPipeline()
	if err != nil {
		f.Fatal(err)
	}

	f.Fuzz(func(t *testing.T, encodedSurface uint8, stream bool, body []byte) {
		if len(body) > 64<<10 {
			body = body[:64<<10]
		}
		newDecoder := func() RequestDecoder {
			switch encodedSurface % 3 {
			case 0:
				return NewOpenAIChatRequestDecoder()
			case 1:
				return NewOpenAIResponsesRequestDecoder()
			default:
				return NewAnthropicMessagesRequestDecoder()
			}
		}
		first, firstErr := newDecoder().Decode(context.Background(), body, stream)
		second, secondErr := newDecoder().Decode(context.Background(), body, stream)
		if (firstErr == nil) != (secondErr == nil) {
			t.Fatalf("decode stability mismatch: first=%v second=%v", firstErr, secondErr)
		}
		if firstErr != nil {
			if firstErr.Code == "" || secondErr.Code != firstErr.Code || secondErr.Surface != firstErr.Surface || secondErr.Field != firstErr.Field {
				t.Fatalf("unstable transform error: first=%+v second=%+v", firstErr, secondErr)
			}
			if strings.Contains(firstErr.Error(), secretSentinel) {
				t.Fatalf("transform error leaked secret sentinel: %q", firstErr)
			}
			return
		}
		if !reflect.DeepEqual(first, second) {
			t.Fatal("request decoding is nondeterministic")
		}
		policy := LosslessOnly
		if encodedSurface&0x80 != 0 {
			policy = AllowLossy
		}
		result, applyErr := pipeline.Apply(context.Background(), first, policy)
		if applyErr != nil {
			if strings.Contains(applyErr.Error(), secretSentinel) {
				t.Fatalf("pipeline error leaked secret sentinel: %q", applyErr)
			}
			var transformErr *TransformError
			if !errors.As(applyErr, &transformErr) || transformErr.Code == "" {
				t.Fatalf("pipeline returned uncoded error: %T %v", applyErr, applyErr)
			}
			return
		}
		if result == nil || result.Request == nil {
			t.Fatal("pipeline returned nil successful result")
		}
		if err := result.Request.Validate(); err != nil {
			t.Fatalf("pipeline returned invalid request: %v", err)
		}
		if err := result.Report.Validate(); err != nil {
			t.Fatalf("pipeline returned invalid report: %v", err)
		}
		if len(result.Report.Diagnostics) > len(pipeline.stages) {
			t.Fatalf("diagnostics=%d exceeds stage bound=%d", len(result.Report.Diagnostics), len(pipeline.stages))
		}
		encoded, err := json.Marshal(result.Request)
		if err != nil {
			t.Fatalf("normalized request is not encodable: %v", err)
		}
		if len(encoded) > 8*len(body)+8192 {
			t.Fatalf("normalized request expanded without bound: input=%d output=%d", len(body), len(encoded))
		}
	})
}
