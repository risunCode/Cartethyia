package transport

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"mime"
	"strings"
	"unicode/utf8"
)

const (
	DefaultMaxSSELineBytes  = 64 << 10
	DefaultMaxSSEEventBytes = 1 << 20
	sseReadBufferBytes      = 4 << 10
)

type sseFailureKind uint8

const (
	sseFailureRead sseFailureKind = iota + 1
	sseFailureMalformed
	sseFailureOversized
	sseFailureTruncated
)

type sseDecodeError struct {
	kind  sseFailureKind
	cause error
}

func (e *sseDecodeError) Error() string {
	switch e.kind {
	case sseFailureRead:
		return "SSE read failed"
	case sseFailureMalformed:
		return "SSE framing is malformed"
	case sseFailureOversized:
		return "SSE framing exceeded its bound"
	case sseFailureTruncated:
		return "SSE event was truncated"
	default:
		return "SSE decoding failed"
	}
}

func (e *sseDecodeError) Unwrap() error { return e.cause }

type sseEvent struct {
	Event string
	ID    string
	Data  []byte
}

type sseDecoder struct {
	reader        *bufio.Reader
	maxLineBytes  int
	maxEventBytes int
	line          []byte
	data          []byte
	event         string
	lastID        string
	hasData       bool
	firstLine     bool
}

func newSSEDecoder(reader io.Reader, maxLineBytes, maxEventBytes int) *sseDecoder {
	if maxLineBytes <= 0 {
		maxLineBytes = DefaultMaxSSELineBytes
	}
	if maxEventBytes <= 0 {
		maxEventBytes = DefaultMaxSSEEventBytes
	}
	return &sseDecoder{
		reader:        bufio.NewReaderSize(reader, sseReadBufferBytes),
		maxLineBytes:  maxLineBytes,
		maxEventBytes: maxEventBytes,
		firstLine:     true,
	}
}

func (d *sseDecoder) Next() (sseEvent, error) {
	for {
		line, partial, err := d.readLine()
		if err != nil {
			return sseEvent{}, err
		}
		if partial {
			return sseEvent{}, &sseDecodeError{kind: sseFailureTruncated, cause: io.ErrUnexpectedEOF}
		}
		if d.firstLine {
			d.firstLine = false
			line = bytes.TrimPrefix(line, []byte{0xef, 0xbb, 0xbf})
		}
		if !utf8.Valid(line) {
			return sseEvent{}, &sseDecodeError{kind: sseFailureMalformed, cause: errors.New("invalid UTF-8")}
		}
		if len(line) == 0 {
			if !d.hasData {
				d.event = ""
				continue
			}
			return d.dispatch(), nil
		}
		if line[0] == ':' {
			continue
		}
		field := line
		value := []byte(nil)
		if colon := bytes.IndexByte(line, ':'); colon >= 0 {
			field = line[:colon]
			value = line[colon+1:]
			if len(value) > 0 && value[0] == ' ' {
				value = value[1:]
			}
		}
		switch string(field) {
		case "data":
			extra := len(value)
			if d.hasData {
				extra++
			}
			if !d.canGrowEvent(extra) {
				return sseEvent{}, &sseDecodeError{kind: sseFailureOversized}
			}
			if d.hasData {
				d.data = append(d.data, '\n')
			}
			d.data = append(d.data, value...)
			d.hasData = true
		case "event":
			if len(d.data)+len(d.lastID)+len(value) > d.maxEventBytes {
				return sseEvent{}, &sseDecodeError{kind: sseFailureOversized}
			}
			d.event = string(value)
		case "id":
			if bytes.IndexByte(value, 0) >= 0 {
				continue
			}
			if len(d.data)+len(d.event)+len(value) > d.maxEventBytes {
				return sseEvent{}, &sseDecodeError{kind: sseFailureOversized}
			}
			d.lastID = string(value)
		}
	}
}

func (d *sseDecoder) readLine() ([]byte, bool, error) {
	d.line = d.line[:0]
	for {
		fragment, err := d.reader.ReadSlice('\n')
		if len(fragment) > d.maxLineBytes+2-len(d.line) {
			return nil, false, &sseDecodeError{kind: sseFailureOversized}
		}
		d.line = append(d.line, fragment...)
		switch {
		case err == nil:
			d.line = d.line[:len(d.line)-1]
			if len(d.line) > 0 && d.line[len(d.line)-1] == '\r' {
				d.line = d.line[:len(d.line)-1]
			}
			if len(d.line) > d.maxLineBytes {
				return nil, false, &sseDecodeError{kind: sseFailureOversized}
			}
			return d.line, false, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(d.line) > d.maxLineBytes {
				return nil, false, &sseDecodeError{kind: sseFailureOversized}
			}
			if len(d.line) == 0 && !d.hasData && len(d.event) == 0 {
				return nil, false, io.EOF
			}
			return d.line, true, nil
		default:
			return nil, false, &sseDecodeError{kind: sseFailureRead, cause: err}
		}
	}
}

func (d *sseDecoder) canGrowEvent(extra int) bool {
	if extra < 0 || extra > d.maxEventBytes {
		return false
	}
	used := len(d.data) + len(d.event) + len(d.lastID)
	return used <= d.maxEventBytes-extra
}

func (d *sseDecoder) dispatch() sseEvent {
	event := sseEvent{
		Event: d.event,
		ID:    d.lastID,
		Data:  d.data,
	}
	d.data = nil
	d.event = ""
	d.hasData = false
	return event
}

func isSSEDone(data []byte) bool {
	return bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]"))
}

func isSSEMediaType(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && strings.EqualFold(mediaType, "text/event-stream")
}
