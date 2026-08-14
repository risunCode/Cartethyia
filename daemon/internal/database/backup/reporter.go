package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// FailureReport is the structured payload describing a failed backup attempt.
type FailureReport struct {
	// Stage is the pipeline stage that produced the error.
	Stage Stage
	// Message is a human-readable description of the failure.
	Message string
	// Attempt is the 1-based attempt counter.
	Attempt int
	// OccurredAt is the UTC timestamp of the failure.
	OccurredAt time.Time
	// Detail, when non-empty, is appended below the message (e.g. a stack
	// trace, a system journal excerpt). Optional.
	Detail string
}

// FailureReporter delivers a structured failure summary to the operator.
//
// Implementations must respect ctx. The orchestrator calls Report after a
// backup fails; the report MUST NOT be sent for successful runs.
type FailureReporter interface {
	// Report transmits the failure summary.
	Report(ctx context.Context, report FailureReport) error
}

// TelegramReporter posts a failure summary to a Telegram chat via the
// sendMessage endpoint. It reuses the same HTTPDoer and BotToken contract as
// the uploader so the wiring layer can share transports.
type TelegramReporter struct {
	Client   HTTPDoer
	BotToken string
	ChatID   int64
	Endpoint string
}

// Report sends the message to the configured chat.
func (r *TelegramReporter) Report(ctx context.Context, report FailureReport) error {
	if r == nil {
		return errors.New("backup: nil TelegramReporter")
	}
	if r.Client == nil {
		return errors.New("backup: TelegramReporter.Client is nil")
	}
	if strings.TrimSpace(r.BotToken) == "" {
		return errors.New("backup: TelegramReporter.BotToken is empty")
	}
	if r.ChatID == 0 {
		return errors.New("backup: TelegramReporter.ChatID is zero")
	}
	if strings.TrimSpace(r.Endpoint) == "" {
		return errors.New("backup: TelegramReporter.Endpoint is empty")
	}
	if report.OccurredAt.IsZero() {
		report.OccurredAt = time.Now().UTC()
	}

	text, err := formatFailureMessage(report)
	if err != nil {
		return newStageError(StageReport, 1, err)
	}

	endpoint, err := r.buildSendMessageURL()
	if err != nil {
		return newStageError(StageReport, 1, err)
	}

	payload, err := json.Marshal(map[string]string{
		"chat_id": fmt.Sprintf("%d", r.ChatID),
		"text":    text,
	})
	if err != nil {
		return newStageError(StageReport, 1, fmt.Errorf("marshal payload: %w", err))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return newStageError(StageReport, 1, fmt.Errorf("build request: %w", err))
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.Client.Do(req)
	if err != nil {
		return newStageError(StageReport, 1, fmt.Errorf("http do: %w", err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.CopyN(io.Discard, resp.Body, 1024)
		return newStageError(StageReport, 1, fmt.Errorf("telegram status %d", resp.StatusCode))
	}
	return nil
}

func (r *TelegramReporter) buildSendMessageURL() (string, error) {
	base := strings.TrimRight(r.Endpoint, "/")
	if base == "" {
		return "", errors.New("endpoint is empty after trim")
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse endpoint: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("endpoint missing scheme or host: %q", base)
	}
	for _, ch := range r.BotToken {
		ok := ch == '-' || ch == '_' || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
		if !ok {
			return "", fmt.Errorf("bot token contains invalid character %q", ch)
		}
	}
	return base + "/bot" + r.BotToken + "/sendMessage", nil
}

// formatFailureMessage renders a compact single-message summary of a failure.
func formatFailureMessage(report FailureReport) (string, error) {
	if strings.TrimSpace(report.Message) == "" {
		return "", errors.New("failure report message is empty")
	}
	var b strings.Builder
	b.Grow(128)
	b.WriteString("[cartethyia-backup] FAILED at stage ")
	b.WriteString(string(report.Stage))
	b.WriteString(" (attempt ")
	b.WriteString(fmt.Sprintf("%d", report.Attempt))
	b.WriteString(")\n")
	b.WriteString("at: ")
	b.WriteString(report.OccurredAt.Format(time.RFC3339))
	b.WriteByte('\n')
	b.WriteString("error: ")
	b.WriteString(report.Message)
	if report.Detail != "" {
		b.WriteByte('\n')
		b.WriteString("detail: ")
		b.WriteString(report.Detail)
	}
	return b.String(), nil
}
