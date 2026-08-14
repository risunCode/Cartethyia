// Package wire contains the HTTP wire helpers shared by Cartethyia /v1 handlers.
// It owns bounded JSON parsing, content-type checks, stream detection, and
// upstream-to-client stream copying without business logic.
package wire

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
)

// ReadBoundedJSON reads at most limit bytes from r.Body, decodes one JSON value,
// and re-encodes it as canonical JSON for downstream consumers.
func ReadBoundedJSON(r *http.Request, limit int64) ([]byte, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return nil, &contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusBadRequest,
			Message:    "request body must be valid JSON",
			Err:        err,
		}
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, &contracts.RouteError{
			Kind:       contracts.ErrorInvalidRequest,
			StatusCode: http.StatusBadRequest,
			Message:    "request body must contain a single JSON value",
			Err:        err,
		}
	}
	return json.Marshal(raw)
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
func WriteStream(ctx context.Context, w http.ResponseWriter, stream apicontracts.Stream) error {
	if ctx == nil {
		ctx = context.Background()
	}
	body := stream.Body()
	defer body.Close()

	if contentType := stream.ContentType(); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	for key, values := range stream.Headers() {
		if key == "Content-Length" || key == "Content-Type" {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(stream.StatusCode())

	buffer := make([]byte, 32*1024)
	for {
		if err := ctx.Err(); err != nil {
			if sink, ok := body.(interface{ Abort(error) }); ok {
				sink.Abort(err)
			}
			return err
		}
		n, err := readStream(ctx, body, buffer)
		if n > 0 {
			written, writeErr := w.Write(buffer[:n])
			if writeErr != nil {
				if sink, ok := body.(interface{ Abort(error) }); ok {
					sink.Abort(writeErr)
				}
				return writeErr
			}
			if written != n {
				shortWrite := errors.New("short stream write")
				if sink, ok := body.(interface{ Abort(error) }); ok {
					sink.Abort(shortWrite)
				}
				return shortWrite
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			if sink, ok := body.(interface{ Abort(error) }); ok {
				sink.Abort(err)
			}
			return err
		}
	}
}

func readStream(ctx context.Context, body apicontracts.StreamReader, buffer []byte) (int, error) {
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
