package router

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

func TestDefaultLimitsAndSanitizeError(t *testing.T) {
	t.Parallel()
	limits := DefaultLimits()
	if limits.MaxBodyBytes <= 0 || limits.MaxHeaderBytes <= 0 || limits.MaxHeaderCount <= 0 {
		t.Fatalf("DefaultLimits returned non-positive bounds: %+v", limits)
	}
	err := NewSanitizeError("model", "too long")
	if err.Error() != "model: too long" {
		t.Fatalf("SanitizeError.Error = %q", err.Error())
	}
}

func TestSanitizeRequestExtractsModelStreamAndImages(t *testing.T) {
	t.Parallel()
	body := []byte(`{"model":"gpt-test","stream":"true","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,abc"}},{"type":"image","image":"http://x"}]}]}`)
	req, err := http.NewRequest(http.MethodPost, "http://example.test", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Request-ID", "req-1")
	result, err := SanitizeRequest(context.Background(), req, SanitizeLimits{})
	if err != nil {
		t.Fatalf("SanitizeRequest: %v", err)
	}
	if result.Model != "gpt-test" || !result.Stream || result.DetectedImages < 2 {
		t.Fatalf("result=%+v", result)
	}
	if got := result.Headers.Get("Authorization"); got != "Bearer secret" {
		t.Fatalf("headers lost authorization: %q", got)
	}
}

func TestSanitizeRequestRejectsHostileInputs(t *testing.T) {
	t.Parallel()
	limits := DefaultLimits()
	limits.MaxBodyBytes = 8
	limits.MaxHeaderBytes = 4
	limits.MaxHeaderCount = 1
	limits.MaxModelLength = 4

	if _, err := SanitizeRequest(context.Background(), nil, limits); err == nil {
		t.Fatal("nil request accepted")
	}

	tooMany := &http.Request{Header: http.Header{"A": []string{"1"}, "B": []string{"2"}}}
	if _, err := SanitizeRequest(context.Background(), tooMany, limits); !errors.Is(err, ErrTooManyHeaders) {
		t.Fatalf("too many headers err=%v", err)
	}

	largeHeader := &http.Request{Header: http.Header{"X-Long": []string{"abcdef"}}}
	if _, err := SanitizeRequest(context.Background(), largeHeader, limits); !errors.Is(err, ErrHeaderTooLarge) {
		t.Fatalf("header too large err=%v", err)
	}

	largeBody, _ := http.NewRequest(http.MethodPost, "/", strings.NewReader("0123456789"))
	if _, err := SanitizeRequest(context.Background(), largeBody, limits); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("body too large err=%v", err)
	}

	invalidUTF8, _ := http.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte{0xff, 0xfe, 0xfd}))
	if _, err := SanitizeRequest(context.Background(), invalidUTF8, limits); !errors.Is(err, ErrInvalidUTF8) {
		t.Fatalf("invalid utf8 err=%v", err)
	}

	longModel, _ := http.NewRequest(http.MethodPost, "/", strings.NewReader(`{"model":"toolong"}`))
	if _, err := SanitizeRequest(context.Background(), longModel, limits); err == nil {
		t.Fatal("long model accepted")
	}

	empty, _ := http.NewRequest(http.MethodPost, "/", http.NoBody)
	result, err := SanitizeRequest(context.Background(), empty, DefaultLimits())
	if err != nil || result == nil || len(result.Body) != 0 {
		t.Fatalf("empty body result=%+v err=%v", result, err)
	}

	nonJSON, _ := http.NewRequest(http.MethodPost, "/", strings.NewReader(`["not-object"]`))
	result, err = SanitizeRequest(context.Background(), nonJSON, DefaultLimits())
	if err != nil || result.Model != "" || result.Stream {
		t.Fatalf("non-json object result=%+v err=%v", result, err)
	}
}

func TestSanitizeMultipartMessageAndURL(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(part, "hello-multipart"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(bytes.NewReader(buf.Bytes()), writer.Boundary())
	body, err := SanitizeMultipart(reader, 0)
	if err != nil {
		t.Fatalf("SanitizeMultipart: %v", err)
	}
	if !bytes.Contains(body, []byte("hello-multipart")) {
		t.Fatalf("multipart body=%q", body)
	}
	if _, err := SanitizeMultipart(nil, 10); err == nil {
		t.Fatal("nil multipart accepted")
	}

	var oversized bytes.Buffer
	ow := multipart.NewWriter(&oversized)
	op, _ := ow.CreateFormFile("file", "big.bin")
	_, _ = io.WriteString(op, strings.Repeat("x", 32))
	_ = ow.Close()
	if _, err := SanitizeMultipart(multipart.NewReader(bytes.NewReader(oversized.Bytes()), ow.Boundary()), 8); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("oversized multipart err=%v", err)
	}

	msg := SanitizeMessage("line1\r\nline2\x01tail", 8)
	if strings.ContainsAny(msg, "\r\n\x01") || len(msg) > 8 {
		t.Fatalf("SanitizeMessage=%q", msg)
	}
	if got := SanitizeMessage("abc", 0); got != "abc" {
		t.Fatalf("default max SanitizeMessage=%q", got)
	}

	if _, err := SanitizeURL("", 10); err == nil {
		t.Fatal("empty url accepted")
	}
	if _, err := SanitizeURL("http://example.test/\x00", 64); err == nil {
		t.Fatal("control byte url accepted")
	}
	if _, err := SanitizeURL(strings.Repeat("a", 20), 8); err == nil {
		t.Fatal("long url accepted")
	}
	cleaned, err := SanitizeURL("https://example.test/path", 0)
	if err != nil || cleaned != "https://example.test/path" {
		t.Fatalf("SanitizeURL=%q err=%v", cleaned, err)
	}
}

func TestCountImageOccurrencesHelper(t *testing.T) {
	t.Parallel()
	payload := []byte(`{"image_url":1,"image":2,"data:image/png":3}`)
	if got := countImageOccurrences(payload, 1024); got < 3 {
		t.Fatalf("countImageOccurrences=%d", got)
	}
	if boundedCount(nil, nil) != 0 {
		t.Fatal("empty needle should count as 0")
	}
}
