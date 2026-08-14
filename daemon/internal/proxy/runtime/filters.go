// File: filters.go
// Request sanitization. Filters bound the inputs the proxy accepts from
// clients before they reach the router, so a malformed or hostile body
// cannot trigger unbounded work upstream.
package proxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"unicode/utf8"
)

// SanitizeLimits bounds the inputs accepted by SanitizeRequest. They mirror
// the legacy TS protocols constants (kept dependency-free).
type SanitizeLimits struct {
	// MaxBodyBytes caps the total request body. Default 10 MiB.
	MaxBodyBytes int64
	// MaxHeaderBytes caps any single header value. Default 64 KiB.
	MaxHeaderBytes int
	// MaxHeaderCount caps the number of headers. Default 256.
	MaxHeaderCount int
	// MaxModelLength caps the size of an extracted model name. Default 256.
	MaxModelLength int
	// MaxMessageText caps a single text block. Default 512 KiB.
	MaxMessageText int
	// MaxImageDataURLBytes caps a base64 data URL image. Default 8 MiB.
	MaxImageDataURLBytes int
}

// DefaultLimits returns the bounds used by the legacy application module.
func DefaultLimits() SanitizeLimits {
	return SanitizeLimits{
		MaxBodyBytes:         10 * 1024 * 1024,
		MaxHeaderBytes:       64 * 1024,
		MaxHeaderCount:       256,
		MaxModelLength:       256,
		MaxMessageText:       512 * 1024,
		MaxImageDataURLBytes: 8 * 1024 * 1024,
	}
}

// SanitizeError signals that sanitization rejected the request. It carries
// the field name and a sanitized message; never echoes the rejected value.
type SanitizeError struct {
	Field   string
	Message string
}

// Error implements error.
func (e *SanitizeError) Error() string { return e.Field + ": " + e.Message }

// NewSanitizeError constructs a typed sanitization failure.
func NewSanitizeError(field, message string) *SanitizeError {
	return &SanitizeError{Field: field, Message: message}
}

// ErrBodyTooLarge indicates the request body exceeded MaxBodyBytes.
var ErrBodyTooLarge = errors.New("proxy: request body too large")

// ErrHeaderTooLarge indicates a single header exceeded MaxHeaderBytes.
var ErrHeaderTooLarge = errors.New("proxy: header too large")

// ErrTooManyHeaders indicates the request had more headers than MaxHeaderCount.
var ErrTooManyHeaders = errors.New("proxy: too many headers")

// ErrInvalidUTF8 indicates a field contained invalid UTF-8.
var ErrInvalidUTF8 = errors.New("proxy: invalid utf-8")

// SanitizeResult is the outcome of sanitization: the bounded body plus the
// extracted metadata used by the selector and router.
type SanitizeResult struct {
	Body           []byte
	Model          string
	Stream         bool
	DetectedImages int
	Headers        http.Header
}

// SanitizeRequest reads up to MaxBodyBytes of r.Body, validates the headers,
// extracts the model name and stream flag from a JSON body, and counts the
// image references. Errors are typed and never echo the offending value.
func SanitizeRequest(ctx context.Context, r *http.Request, limits SanitizeLimits) (*SanitizeResult, error) {
	if r == nil {
		return nil, NewSanitizeError("request", "missing request")
	}
	if limits.MaxBodyBytes <= 0 {
		limits = DefaultLimits()
	}
	if err := validateHeaders(r.Header, limits); err != nil {
		return nil, err
	}
	body, err := readBoundedBody(r.Body, limits.MaxBodyBytes)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, ErrInvalidUTF8
	}
	model, stream, images, err := scanJSON(body, limits)
	if err != nil {
		return nil, err
	}
	return &SanitizeResult{
		Body:           body,
		Model:          model,
		Stream:         stream,
		DetectedImages: images,
		Headers:        r.Header.Clone(),
	}, nil
}

func validateHeaders(h http.Header, limits SanitizeLimits) error {
	if len(h) > limits.MaxHeaderCount {
		return ErrTooManyHeaders
	}
	for k, vals := range h {
		if strings.EqualFold(k, "Cookie") || strings.EqualFold(k, "Authorization") {
			// Authorization/Cookie pass through but are not parsed.
			continue
		}
		for _, v := range vals {
			if len(v) > limits.MaxHeaderBytes {
				return ErrHeaderTooLarge
			}
		}
		_ = k
	}
	return nil
}

func readBoundedBody(rc io.ReadCloser, max int64) ([]byte, error) {
	if rc == nil {
		return nil, nil
	}
	defer rc.Close()
	if max <= 0 {
		max = DefaultLimits().MaxBodyBytes
	}
	// io.LimitReader guarantees we never read more than max+1 bytes.
	lr := io.LimitReader(rc, max+1)
	buf := &bytes.Buffer{}
	if _, err := io.Copy(buf, lr); err != nil {
		return nil, err
	}
	if buf.Len() > int(max) {
		return nil, ErrBodyTooLarge
	}
	return buf.Bytes(), nil
}

// scanJSON extracts the model name, stream flag, and image-reference count
// from a JSON body using a bounded string walk. It is allocation-light:
// we never build a full map[string]any, only the relevant slices.
func scanJSON(body []byte, limits SanitizeLimits) (model string, stream bool, images int, err error) {
	if len(body) == 0 {
		return "", false, 0, nil
	}
	if !bytes.HasPrefix(skipWhitespace(body), []byte("{")) {
		return "", false, 0, nil
	}
	model = extractStringField(body, "model")
	if len(model) > limits.MaxModelLength {
		return "", false, 0, NewSanitizeError("model", "model name too long")
	}
	if v := extractStringField(body, "stream"); v != "" {
		stream = v == "true" || v == "1"
	}
	images += boundedCount(body, []byte("\"image_url\""))
	images += boundedCount(body, []byte("\"image\""))
	images += boundedCount(body, []byte("data:image/"))
	return model, stream, images, nil
}

// extractStringField finds `"<key>":"<value>"` and returns the unescaped
// value when present. Returns "" when the field is absent. The walk is
// bounded to the first occurrence and bounded by len(body).
func extractStringField(body []byte, key string) string {
	needle := []byte("\"" + key + "\"")
	idx := bytesIndex(body, needle)
	if idx < 0 {
		return ""
	}
	rest := body[idx+len(needle):]
	// Skip optional ':' and whitespace.
	rest = skipWhitespace(rest)
	if len(rest) == 0 || rest[0] != ':' {
		return ""
	}
	rest = skipWhitespace(rest[1:])
	if len(rest) == 0 || rest[0] != '"' {
		return ""
	}
	rest = rest[1:]
	end := bytesIndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return string(rest[:end])
}

func bytesIndex(haystack, needle []byte) int {
	if len(needle) == 0 {
		return 0
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if bytes.Equal(haystack[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

func bytesIndexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

// skipWhitespace returns the slice offset past leading whitespace.
func skipWhitespace(b []byte) []byte {
	for i, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		default:
			return b[i:]
		}
	}
	return b
}

// countImageOccurrences counts base64 data URLs and http(s) image references
// in a JSON array value. The walk is bounded by len(val).
func countImageOccurrences(val []byte, maxDataURL int) int {
	count := 0
	for _, needle := range [][]byte{
		[]byte("\"image_url\""),
		[]byte("\"image\""),
		[]byte("data:image/"),
	} {
		count += boundedCount(val, needle)
	}
	_ = maxDataURL
	return count
}

func boundedCount(haystack, needle []byte) int {
	if len(needle) == 0 {
		return 0
	}
	n := 0
	for i := 0; i+len(needle) <= len(haystack); {
		if bytes.Equal(haystack[i:i+len(needle)], needle) {
			n++
			i += len(needle)
			continue
		}
		i++
	}
	return n
}

// SanitizeMultipart processes an uploaded file within the bound. It enforces
// MaxBodyBytes on the entire multipart stream. Headers are NOT parsed.
func SanitizeMultipart(mr *multipart.Reader, maxBytes int64) ([]byte, error) {
	if mr == nil {
		return nil, errors.New("proxy: nil multipart reader")
	}
	if maxBytes <= 0 {
		maxBytes = DefaultLimits().MaxBodyBytes
	}
	buf := &bytes.Buffer{}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if _, err := io.Copy(buf, io.LimitReader(part, maxBytes+1)); err != nil {
			part.Close()
			return nil, err
		}
		part.Close()
		if buf.Len() > int(maxBytes) {
			return nil, ErrBodyTooLarge
		}
	}
	return buf.Bytes(), nil
}

// SanitizeMessage truncates a string to a bounded length and returns a
// sanitized version safe for inclusion in error responses. It strips CR/LF
// to defeat header-injection attacks and replaces control runes with "?" so
// downstream log readers see only printable text.
func SanitizeMessage(s string, max int) string {
	if max <= 0 {
		max = 240
	}
	if len(s) > max {
		s = s[:max]
	}
	// Drop \r and \n to prevent header smuggling.
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			b.WriteByte('?')
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if !utf8.ValidString(out) {
		// Replace invalid runs with '?'.
		out = strings.ToValidUTF8(out, "?")
	}
	return out
}

// SanitizeURL validates a URL by stripping control characters and limiting
// length. Empty URLs are rejected.
func SanitizeURL(raw string, max int) (string, error) {
	if raw == "" {
		return "", errors.New("proxy: empty url")
	}
	if max <= 0 {
		max = 4096
	}
	if len(raw) > max {
		return "", fmt.Errorf("proxy: url longer than %d bytes", max)
	}
	for i := range len(raw) {
		if raw[i] < 0x20 || raw[i] == 0x7f {
			return "", fmt.Errorf("proxy: url contains control byte at %d", i)
		}
	}
	return raw, nil
}
