package transport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	proxy "github.com/cartethyia/daemon/internal/proxy"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type fragmentReader struct {
	data  []byte
	width int
}

func (r *fragmentReader) Read(dst []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	width := r.width
	if width <= 0 || width > len(r.data) {
		width = len(r.data)
	}
	if width > len(dst) {
		width = len(dst)
	}
	copy(dst, r.data[:width])
	r.data = r.data[width:]
	return width, nil
}

type errorReader struct {
	err error
}

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

type closeTrackingBody struct {
	reader io.Reader
	reads  atomic.Int32
	closed chan struct{}
}

func (r *closeTrackingBody) Read(dst []byte) (int, error) {
	r.reads.Add(1)
	return r.reader.Read(dst)
}

func (r *closeTrackingBody) Close() error {
	select {
	case <-r.closed:
	default:
		close(r.closed)
	}
	return nil
}

func TestSSEDecoderFragmentedFieldsAndLineEndings(t *testing.T) {
	input := []byte("\xef\xbb\xbf: keepalive\r\nevent: response.output_text.delta\r\nid: evt-1\r\ndata: {\"delta\":\"hello\"}\r\ndata: {\"delta\":\"world\"}\r\n\r\n: ignored\ndata: tail\n\n")
	want := []sseEvent{
		{Event: "response.output_text.delta", ID: "evt-1", Data: []byte("{\"delta\":\"hello\"}\n{\"delta\":\"world\"}")},
		{ID: "evt-1", Data: []byte("tail")},
	}
	for width := 1; width <= 13; width++ {
		t.Run("width="+string(rune('A'+width-1)), func(t *testing.T) {
			decoder := newSSEDecoder(&fragmentReader{data: append([]byte(nil), input...), width: width}, 256, 1024)
			for index, expected := range want {
				got, err := decoder.Next()
				if err != nil {
					t.Fatalf("event %d: %v", index, err)
				}
				if got.Event != expected.Event || got.ID != expected.ID || !bytes.Equal(got.Data, expected.Data) {
					t.Fatalf("event %d = %#v, want %#v", index, got, expected)
				}
			}
			if _, err := decoder.Next(); !errors.Is(err, io.EOF) {
				t.Fatalf("final error = %v, want EOF", err)
			}
		})
	}
}

func TestSSEDecoderRejectsBoundViolationsAndTruncation(t *testing.T) {
	tests := []struct {
		name       string
		reader     io.Reader
		lineLimit  int
		eventLimit int
		wantKind   sseFailureKind
	}{
		{name: "line", reader: strings.NewReader("data: 123456789\n\n"), lineLimit: 8, eventLimit: 64, wantKind: sseFailureOversized},
		{name: "line at EOF", reader: strings.NewReader("data: 123456789"), lineLimit: 8, eventLimit: 64, wantKind: sseFailureOversized},
		{name: "event", reader: strings.NewReader("data: 12345\ndata: 67890\n\n"), lineLimit: 32, eventLimit: 10, wantKind: sseFailureOversized},
		{name: "invalid UTF-8", reader: bytes.NewReader([]byte{'d', 'a', 't', 'a', ':', ' ', 0xff, '\n', '\n'}), lineLimit: 32, eventLimit: 32, wantKind: sseFailureMalformed},
		{name: "partial event", reader: strings.NewReader("data: partial"), lineLimit: 32, eventLimit: 32, wantKind: sseFailureTruncated},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := newSSEDecoder(test.reader, test.lineLimit, test.eventLimit).Next()
			var decodeErr *sseDecodeError
			if !errors.As(err, &decodeErr) || decodeErr.kind != test.wantKind {
				t.Fatalf("error = %#v, want SSE kind %d", err, test.wantKind)
			}
		})
	}
}

func TestSSEDecoderRedactsReaderFailures(t *testing.T) {
	const secret = "proxy-password-SENTINEL-sse-reader"
	_, err := newSSEDecoder(errorReader{err: errors.New(secret)}, 32, 64).Next()
	var decodeErr *sseDecodeError
	if !errors.As(err, &decodeErr) || decodeErr.kind != sseFailureRead {
		t.Fatalf("error = %#v, want read failure", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("decoder error leaked reader text: %q", err)
	}
}

func TestSSEMediaTypeAndDoneSignal(t *testing.T) {
	for _, contentType := range []string{"text/event-stream", "Text/Event-Stream; charset=utf-8"} {
		if !isSSEMediaType(contentType) {
			t.Fatalf("media type %q rejected", contentType)
		}
	}
	for _, contentType := range []string{"", "application/json", "text/event-stream; charset"} {
		if isSSEMediaType(contentType) {
			t.Fatalf("media type %q accepted", contentType)
		}
	}
	if !isSSEDone([]byte("[DONE]")) {
		t.Fatal("[DONE] was not recognized")
	}
	if isSSEDone([]byte(`{"type":"response.completed"}`)) {
		t.Fatal("provider terminal payload was confused with the SSE done sentinel")
	}
}

func TestHTTPTransportRejectsNonSSEBeforeProducerStart(t *testing.T) {
	body := &closeTrackingBody{reader: strings.NewReader("data: [DONE]\n\n"), closed: make(chan struct{})}
	var releases atomic.Int32
	var failureKind string
	transport := newStreamRegressionTransport(t, regressionRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       body,
		}, nil
	}), &releases)
	transport.ProxyFailure = func(_ context.Context, _, kind, _ string) { failureKind = kind }

	stream, err := transport.CallStream(context.Background(), streamRegressionAccount(), streamRegressionRequest())
	if stream != nil {
		stream.Close()
		t.Fatal("CallStream returned a producer for a non-SSE response")
	}
	var routeErr *contracts.RouteError
	if !errors.As(err, &routeErr) || routeErr.Code != "provider.stream_media_type_invalid" {
		t.Fatalf("error = %#v, want provider.stream_media_type_invalid", err)
	}
	select {
	case <-body.closed:
	default:
		t.Fatal("non-SSE upstream body was not closed")
	}
	if got := body.reads.Load(); got != 0 {
		t.Fatalf("upstream body reads = %d, want 0", got)
	}
	if got := releases.Load(); got != 1 {
		t.Fatalf("proxy releases = %d, want 1", got)
	}
	if failureKind != "stream_media_type" {
		t.Fatalf("proxy failure kind = %q, want stream_media_type", failureKind)
	}
}

func TestHTTPTransportDecoderFailureClosesAndAttributesProxy(t *testing.T) {
	const secret = "proxy-password-SENTINEL-upstream-reader"
	body := &closeTrackingBody{reader: errorReader{err: errors.New(secret)}, closed: make(chan struct{})}
	var releases atomic.Int32
	var failureKind string
	transport := newStreamRegressionTransport(t, regressionRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"text/event-stream"}},
			Body:       body,
		}, nil
	}), &releases)
	transport.ProxyFailure = func(_ context.Context, _, kind, _ string) { failureKind = kind }

	stream, err := transport.CallStream(context.Background(), streamRegressionAccount(), streamRegressionRequest())
	if err != nil {
		t.Fatalf("CallStream error = %v", err)
	}
	defer stream.Close()
	preflightErr := stream.Preflight(context.Background())
	if code := proxy.StreamCodeOf(preflightErr); code != proxy.StreamCodeReadFailure {
		t.Fatalf("Preflight code = %q, want %q (err=%v)", code, proxy.StreamCodeReadFailure, preflightErr)
	}
	if strings.Contains(preflightErr.Error(), secret) {
		t.Fatalf("preflight error leaked reader text: %q", preflightErr)
	}
	select {
	case <-body.closed:
	case <-time.After(time.Second):
		t.Fatal("failed upstream body was not closed")
	}
	if got := releases.Load(); got != 1 {
		t.Fatalf("proxy releases = %d, want 1", got)
	}
	if failureKind != "stream_read" {
		t.Fatalf("proxy failure kind = %q, want stream_read", failureKind)
	}
}

func FuzzSSEDecoder(f *testing.F) {
	seeds := [][]byte{
		[]byte("data: {\"type\":\"message_stop\"}\n\n"),
		[]byte("data: [DONE]\n\n"),
		[]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n"),
		[]byte("data: {\"id\":\"chatcmpl_1\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"),
		[]byte(": comment\r\ndata: first\r\ndata: second\r\n\r\n"),
		[]byte("event: error\nid: e-1\ndata: {\"type\":\"error\"}\n\n"),
		[]byte("data: partial"),
		[]byte("data: credential-SENTINEL-sse\n"),
		{'d', 'a', 't', 'a', ':', ' ', 0xff, '\n', '\n'},
		[]byte("data: " + strings.Repeat("x", 600) + "\n\n"),
		[]byte(strings.Repeat(": comment\n", 64) + "\n"),
	}
	for _, seed := range seeds {
		for _, width := range []uint8{1, 2, 7, 31} {
			f.Add(seed, width)
		}
	}
	f.Fuzz(func(t *testing.T, input []byte, width uint8) {
		if len(input) > 4096 {
			input = input[:4096]
		}
		chunk := int(width%64) + 1
		decoder := newSSEDecoder(&fragmentReader{data: input, width: chunk}, 128, 512)
		for events := 0; ; events++ {
			if events > len(input)+1 {
				t.Fatal("decoder made no bounded progress")
			}
			event, err := decoder.Next()
			if len(event.Data) > 512 {
				t.Fatalf("event data length = %d, want <= 512", len(event.Data))
			}
			if cap(decoder.line) > 2*(decoder.maxLineBytes+2) {
				t.Fatalf("line capacity = %d, want bounded", cap(decoder.line))
			}
			if cap(event.Data) > 2*decoder.maxEventBytes {
				t.Fatalf("event capacity = %d, want bounded", cap(event.Data))
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					var decodeErr *sseDecodeError
					if !errors.As(err, &decodeErr) || decodeErr.kind < sseFailureRead || decodeErr.kind > sseFailureTruncated {
						t.Fatalf("decoder returned unclassified error: %T %v", err, err)
					}
				}
				if strings.Contains(err.Error(), "SENTINEL") {
					t.Fatalf("decoder error leaked input: %q", err)
				}
				return
			}
		}
	})
}
