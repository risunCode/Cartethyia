package transport

import (
	"errors"
	"io"
	"testing"
)

func BenchmarkSSEDecode(b *testing.B) {
	payload := []byte("event: response.created\nid: evt-1\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n" +
		"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
		"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n")
	b.ReportAllocs()
	for b.Loop() {
		decoder := newSSEDecoder(&fragmentReader{data: payload, width: 17}, 1024, 4096)
		events := 0
		for {
			_, err := decoder.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				b.Fatal(err)
			}
			events++
		}
		if events != 3 {
			b.Fatalf("events=%d, want 3", events)
		}
	}
}
