package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSecurityVerificationDoesNotSerializeRemoteErrorBody(t *testing.T) {
	const secret = "backup-telegram-secret"
	client := &fakeHTTP{respond: func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Body:       io.NopCloser(bytes.NewBufferString(`{"ok":false,"description":"authorization Bearer ` + secret + `"}`)),
			Header:     make(http.Header),
		}, nil
	}}
	reporter := &TelegramReporter{Client: client, BotToken: "TOKEN", ChatID: 7, Endpoint: "https://api.example"}
	err := reporter.Report(context.Background(), FailureReport{Stage: StageUpload, Message: "upload failed", Attempt: 1, OccurredAt: time.Unix(1, 0).UTC()})
	if err == nil || CodeOf(err) != CodeReportFailed {
		t.Fatalf("err=%v code=%q, want report failure", err, CodeOf(err))
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("remote error body leaked secret: %v", err)
	}
	if !errors.Is(err, &Error{Code: CodeReportFailed}) {
		t.Fatalf("report error lost stable code: %v", err)
	}
}
