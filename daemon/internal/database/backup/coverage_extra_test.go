package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type errorRunner struct{ err error }

func (r errorRunner) Run(context.Context, Command) (io.ReadCloser, error) { return nil, r.err }

func TestScheduleValidateRejectsInvalidValues(t *testing.T) {
	tests := []Schedule{{Interval: 0}, {Interval: -time.Second}, {Interval: time.Second, MaxAttempts: -1}, {Interval: time.Second, RetentionAge: -time.Second}}
	for _, schedule := range tests {
		if err := schedule.Validate(); err == nil {
			t.Fatalf("Validate(%+v) returned nil", schedule)
		}
	}
	if err := (Schedule{Interval: time.Second}).Validate(); err != nil {
		t.Fatalf("valid schedule rejected: %v", err)
	}
}

func TestServiceStartValidatesDependenciesAndCanStop(t *testing.T) {
	svc := New(Schedule{}, &PostgresDumper{}, nil, nil, &fakeMetadata{}, nil)
	if err := svc.Start(context.Background()); err == nil {
		t.Fatal("expected invalid schedule error")
	}
	svc = New(Schedule{Interval: time.Hour}, nil, nil, nil, &fakeMetadata{}, nil)
	if err := svc.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "Dumper") {
		t.Fatalf("err=%v, want missing dumper", err)
	}
	svc = New(Schedule{Interval: time.Hour}, &PostgresDumper{Runner: &fakeRunner{}}, nil, nil, nil, nil)
	if err := svc.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "Metadata") {
		t.Fatalf("err=%v, want missing metadata", err)
	}
	svc = New(Schedule{Interval: time.Hour}, &PostgresDumper{Runner: &fakeRunner{}}, nil, nil, &fakeMetadata{}, nil)
	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := svc.Start(context.Background()); err == nil {
		t.Fatal("second Start unexpectedly succeeded")
	}
	svc.Stop()
	svc.Stop()
}

func TestPostgresDumperDumpValidationAndRunnerError(t *testing.T) {
	var nilDumper *PostgresDumper
	if _, err := nilDumper.Dump(context.Background()); err == nil {
		t.Fatal("nil dumper unexpectedly succeeded")
	}
	if _, err := (&PostgresDumper{}).Dump(context.Background()); err == nil {
		t.Fatal("nil runner unexpectedly succeeded")
	}
	if _, err := (&PostgresDumper{Runner: &fakeRunner{}}).Dump(context.Background()); err == nil {
		t.Fatal("empty command path unexpectedly succeeded")
	}
	want := errors.New("spawn failed")
	_, err := (&PostgresDumper{Runner: errorRunner{err: want}, Command: Command{Path: "pg_dump"}}).Dump(context.Background())
	if err == nil || CodeOf(err) != CodeDumpFailed || !errors.Is(err, want) {
		t.Fatalf("err=%v code=%q, want tagged runner error", err, CodeOf(err))
	}
}

func TestAEADEncryptorRejectsInvalidInputs(t *testing.T) {
	var nilEncryptor *AEADEncryptor
	if _, err := nilEncryptor.Encrypt(context.Background(), bytes.NewReader(nil)); err == nil {
		t.Fatal("nil encryptor unexpectedly succeeded")
	}
	for _, key := range [][]byte{nil, bytes.Repeat([]byte{1}, 15), bytes.Repeat([]byte{1}, 17)} {
		if _, err := (&AEADEncryptor{Key: key}).Encrypt(context.Background(), bytes.NewReader(nil)); err == nil {
			t.Fatalf("key length %d unexpectedly succeeded", len(key))
		}
	}
	if _, err := (&AEADEncryptor{Key: bytes.Repeat([]byte{1}, 16)}).Encrypt(context.Background(), nil); err == nil {
		t.Fatal("nil source unexpectedly succeeded")
	}
}

func TestTelegramUploaderValidationAndContentLength(t *testing.T) {
	var nilUploader *TelegramUploader
	if _, err := nilUploader.Upload(context.Background(), "x", strings.NewReader("x"), 1); err == nil {
		t.Fatal("nil uploader unexpectedly succeeded")
	}
	base := TelegramUploader{Client: &fakeHTTP{}, BotToken: "TOKEN", ChatID: 1, Endpoint: "https://example.test"}
	tests := []TelegramUploader{{}, {Client: &fakeHTTP{}, BotToken: " ", ChatID: 1, Endpoint: "https://example.test"}, {Client: &fakeHTTP{}, BotToken: "TOKEN", Endpoint: "https://example.test"}, {Client: &fakeHTTP{}, BotToken: "TOKEN", ChatID: 1}}
	for i, uploader := range tests {
		if _, err := uploader.Upload(context.Background(), "x", strings.NewReader("x"), 1); err == nil {
			t.Fatalf("validation case %d unexpectedly succeeded", i)
		}
	}
	if _, err := base.Upload(context.Background(), "x", nil, 1); err == nil {
		t.Fatal("nil body unexpectedly succeeded")
	}
	base.BotToken = "bad token"
	if _, err := base.Upload(context.Background(), "x", strings.NewReader("x"), 1); err == nil {
		t.Fatal("invalid token unexpectedly succeeded")
	}
	if got := computeContentLength(10, "boundary", false); got != int64(10+len("boundary")+256) {
		t.Fatalf("content length=%d", got)
	}
	if got := computeContentLength(10, "boundary", true); got != int64(10+len("boundary")+320) {
		t.Fatalf("caption content length=%d", got)
	}
}

func TestErrorCodeStringAndUnknownStage(t *testing.T) {
	var nilErr *Error
	if got := nilErr.CodeString(); got != "" {
		t.Fatalf("nil CodeString=%q", got)
	}
	if got := (&Error{Code: CodeUploadFailed}).CodeString(); got != string(CodeUploadFailed) {
		t.Fatalf("CodeString=%q", got)
	}
	if got := stageCode(Stage("unknown")); got != "" {
		t.Fatalf("unknown stage code=%q", got)
	}
}
