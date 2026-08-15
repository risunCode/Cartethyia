// Package api contains the HTTP wire helpers shared by Cartethyia /v1 handlers.
// It owns bounded JSON parsing, content-type checks, stream detection, and
// upstream-to-client stream copying without business logic.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// ReadBoundedJSON reads at most limit bytes from r.Body, decodes one JSON value,
// and re-encodes it as canonical JSON for downstream consumers.
func ReadBoundedJSON(r *http.Request, limit int64) ([]byte, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return nil, boundedJSONError(err, "request body must be valid JSON")
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, boundedJSONError(err, "request body must contain a single JSON value")
	}
	return json.Marshal(raw)
}

func boundedJSONError(err error, invalidMessage string) error {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return &contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			Code:       "payload_too_large",
			StatusCode: http.StatusRequestEntityTooLarge,
			Message:    "request payload exceeds the maximum allowed size",
			Err:        maxBytesErr,
		}
	}
	return &contracts.RouteError{
		Kind:       contracts.ErrorInvalidRequest,
		StatusCode: http.StatusBadRequest,
		Message:    invalidMessage,
		Err:        err,
	}
}

// HasJSONContentType reports whether the request advertises application/json.
func HasJSONContentType(r *http.Request) bool {
	contentType := r.Header.Get("Content-Type")
	for i := range contentType {
		if contentType[i] == ';' || contentType[i] == ' ' {
			contentType = contentType[:i]
			break
		}
	}
	return contentType == "application/json"
}

// StreamRequested reports whether the normalized JSON body requests streaming.
func StreamRequested(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var probe struct {
		Stream *bool `json:"stream"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return false
	}
	return probe.Stream != nil && *probe.Stream
}

// WriteStream copies an upstream stream to the client, stopping when ctx is
// canceled and reporting downstream writer errors to the stream coordinator.
func WriteStream(ctx context.Context, w http.ResponseWriter, stream Stream) error {
	if ctx == nil {
		ctx = context.Background()
	}
	body := stream.Body()
	defer body.Close()
	if err := ctx.Err(); err != nil {
		abortStream(body, err)
		return err
	}

	contentType, ok := SafeUpstreamResponseContentType(stream.ContentType())
	if !ok {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	CopySafeUpstreamResponseHeaders(w.Header(), stream.Headers())
	isSSE := eventStreamContentType(contentType)
	if isSSE {
		w.Header().Set("Cache-Control", "no-cache")
		if err := RefreshStreamWriteDeadline(ctx, w); err != nil {
			err = downstreamOrContextError(ctx, err)
			abortStream(body, err)
			return err
		}
	}
	w.WriteHeader(stream.StatusCode())
	if isSSE {
		return writeSSE(ctx, w, body)
	}
	return writeBody(ctx, w, body)
}

func writeBody(ctx context.Context, w http.ResponseWriter, body StreamReader) error {
	buffer := make([]byte, 32*1024)
	for {
		if err := ctx.Err(); err != nil {
			abortStream(body, err)
			return err
		}
		n, err := readStream(ctx, body, buffer)
		if n > 0 {
			if writeErr := writeComplete(w, buffer[:n]); writeErr != nil {
				writeErr = markDownstreamFailure(writeErr)
				abortStream(body, writeErr)
				return writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			abortStream(body, err)
			return err
		}
	}
}

func writeSSE(ctx context.Context, w http.ResponseWriter, body StreamReader) error {
	controller := http.NewResponseController(w)
	buffer := make([]byte, 32*1024)
	pending := make([]byte, 0, len(buffer))
	for {
		if err := ctx.Err(); err != nil {
			abortStream(body, err)
			return err
		}
		n, readErr := readStream(ctx, body, buffer)
		if n > 0 {
			pending = append(pending, buffer[:n]...)
			consumed := 0
			for {
				frameBytes := completeSSEFrameBytes(pending[consumed:])
				if frameBytes == 0 {
					break
				}
				end := consumed + frameBytes
				if err := writeComplete(w, pending[consumed:end]); err != nil {
					err = markDownstreamFailure(err)
					abortStream(body, err)
					return err
				}
				if err := controller.Flush(); err != nil {
					err = markDownstreamFailure(err)
					abortStream(body, err)
					return err
				}
				if err := RefreshStreamWriteDeadline(ctx, w); err != nil {
					err = downstreamOrContextError(ctx, err)
					abortStream(body, err)
					return err
				}
				consumed = end
			}
			if consumed > 0 {
				copy(pending, pending[consumed:])
				pending = pending[:len(pending)-consumed]
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if len(pending) == 0 {
					return nil
				}
				readErr = io.ErrUnexpectedEOF
			}
			abortStream(body, readErr)
			return readErr
		}
	}
}

func completeSSEFrameBytes(data []byte) int {
	lf := bytes.Index(data, []byte("\n\n"))
	crlf := bytes.Index(data, []byte("\r\n\r\n"))
	if lf >= 0 && (crlf < 0 || lf < crlf) {
		return lf + 2
	}
	if crlf >= 0 {
		return crlf + 4
	}
	return 0
}

func writeComplete(w io.Writer, data []byte) error {
	written, err := w.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

func abortStream(body StreamReader, err error) {
	if sink, ok := body.(interface{ Abort(error) }); ok {
		sink.Abort(err)
	}
}

type downstreamFailure struct{ cause error }

func (e *downstreamFailure) Error() string      { return "downstream stream failure: " + e.cause.Error() }
func (e *downstreamFailure) Unwrap() error      { return e.cause }
func (e *downstreamFailure) DownstreamFailure() {}

func markDownstreamFailure(err error) error {
	if err == nil {
		return nil
	}
	return &downstreamFailure{cause: err}
}

func downstreamOrContextError(ctx context.Context, err error) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return markDownstreamFailure(err)
}

func eventStreamContentType(contentType string) bool {
	mediaType, _, _ := strings.Cut(contentType, ";")
	return strings.EqualFold(strings.TrimSpace(mediaType), "text/event-stream")
}

func readStream(ctx context.Context, body StreamReader, buffer []byte) (int, error) {
	if reader, ok := body.(interface {
		ReadContext(context.Context, []byte) (int, error)
	}); ok {
		return reader.ReadContext(ctx, buffer)
	}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	default:
		return body.Read(buffer)
	}
}
