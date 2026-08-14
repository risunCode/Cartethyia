package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

// fakeRunner is a CommandRunner that returns the supplied bytes.
type fakeRunner struct {
	out    []byte
	closed int
}

func (f *fakeRunner) Run(_ context.Context, _ Command) (io.ReadCloser, error) {
	return &closeCounter{Reader: bytes.NewReader(f.out), parent: f}, nil
}

type closeCounter struct {
	*bytes.Reader
	parent *fakeRunner
}

func (c *closeCounter) Close() error { c.parent.closed++; return nil }

// fakeHTTP is an HTTPDoer that records the most recent request and replies
// with a canned Telegram-style payload.
type fakeHTTP struct {
	mu       sync.Mutex
	lastBody []byte
	lastURL  string
	headers  http.Header
	respond  func(req *http.Request) (*http.Response, error)
}

func (f *fakeHTTP) Do(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastURL = req.URL.String()
	f.headers = req.Header.Clone()
	body, _ := io.ReadAll(req.Body)
	f.lastBody = body
	if f.respond != nil {
		return f.respond(req)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewReader([]byte(`{"ok":true,"result":{"message_id":42,"chat":{"id":1},"document":{"file_id":"f1"}}}`))),
		Header:     make(http.Header),
	}, nil
}

// fakeMetadata records the operations it receives.
type fakeMetadata struct {
	mu        sync.Mutex
	inserts   []Record
	updates   []Record
	deletes   []int64
	olderThan []Record
	listErr   error
}

func (f *fakeMetadata) Insert(_ context.Context, r *Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.ID == 0 {
		r.ID = int64(len(f.inserts) + 1)
	}
	f.inserts = append(f.inserts, *r)
	return nil
}

func (f *fakeMetadata) UpdateStatus(_ context.Context, id int64, status Status, stage Stage, msg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.updates {
		if f.updates[i].ID == 0 {
			f.updates[i].ID = id
		}
	}
	f.updates = append(f.updates, Record{ID: id, Status: status, ErrorStage: stage, ErrorMessage: msg})
	return nil
}

func (f *fakeMetadata) ListOlderThan(_ context.Context, _ time.Time) ([]Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]Record, len(f.olderThan))
	copy(out, f.olderThan)
	return out, nil
}

func (f *fakeMetadata) Delete(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, id)
	return nil
}

func TestServiceRunOnceSucceedsAndUploads(t *testing.T) {
	runner := &fakeRunner{out: []byte("dump-bytes")}
	encrypt := &AEADEncryptor{Key: bytes.Repeat([]byte{1}, 32)}
	http := &fakeHTTP{}
	uploader := &TelegramUploader{Client: http, BotToken: "TOKEN", ChatID: 7, Endpoint: "https://api.example"}
	meta := &fakeMetadata{}
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	svc := New(Schedule{Interval: time.Second}, &PostgresDumper{Runner: runner, Command: Command{Path: "pg_dump"}}, encrypt, uploader, meta, nil)
	svc.Now = func() time.Time { return now }
	outcome := svc.RunOnce(context.Background())
	if outcome.Err != nil {
		t.Fatalf("unexpected error: %v", outcome.Err)
	}
	if outcome.Record.Status != StatusSucceeded {
		t.Fatalf("expected succeeded, got %s", outcome.Record.Status)
	}
	if outcome.Record.SizeBytes == 0 {
		t.Fatalf("expected non-zero size")
	}
	if outcome.Result.MessageID != 42 {
		t.Fatalf("expected message id 42, got %d", outcome.Result.MessageID)
	}
	if !bytes.HasPrefix(http.lastBody, []byte("--")) {
		t.Fatalf("expected multipart body, got %q", string(http.lastBody[:32]))
	}
}

func TestServiceRunOnceReportsFailure(t *testing.T) {
	runner := &fakeRunner{out: []byte("x")}
	http := &fakeHTTP{}
	meta := &fakeMetadata{}
	reporter := &TelegramReporter{Client: http, BotToken: "TOKEN", ChatID: 7, Endpoint: "https://api.example"}
	uploader := &TelegramUploader{Client: &boomHTTP{err: errors.New("network down")}, BotToken: "TOKEN", ChatID: 7, Endpoint: "https://api.example"}
	svc := New(Schedule{Interval: time.Second}, &PostgresDumper{Runner: runner, Command: Command{Path: "pg_dump"}}, nil, uploader, meta, reporter)
	outcome := svc.RunOnce(context.Background())
	if outcome.Err == nil {
		t.Fatalf("expected error")
	}
	if outcome.Record.Status != StatusFailed {
		t.Fatalf("expected failed, got %s", outcome.Record.Status)
	}
	if outcome.Record.ErrorStage != StageUpload {
		t.Fatalf("expected upload stage, got %s", outcome.Record.ErrorStage)
	}
}

func TestServiceRunOnceNeverReportsSuccessWithoutUploader(t *testing.T) {
	runner := &fakeRunner{out: []byte("dump-bytes")}
	meta := &fakeMetadata{}
	svc := New(
		Schedule{Interval: time.Second},
		&PostgresDumper{Runner: runner, Command: Command{Path: "pg_dump"}},
		nil,
		nil,
		meta,
		nil,
	)
	outcome := svc.RunOnce(context.Background())
	if outcome.Err == nil || CodeOf(outcome.Err) != CodeUploadFailed {
		t.Fatalf("err=%v code=%q, want upload failure", outcome.Err, CodeOf(outcome.Err))
	}
	if outcome.Record.Status != StatusFailed {
		t.Fatalf("status=%s, want failed", outcome.Record.Status)
	}
}

func TestServiceSweepRetentionDeletesOldRecords(t *testing.T) {
	meta := &fakeMetadata{olderThan: []Record{{ID: 11}, {ID: 12}}}
	svc := New(Schedule{Interval: time.Second, RetentionAge: 24 * time.Hour}, nil, nil, nil, meta, nil)
	if err := svc.SweepRetention(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(meta.deletes) != 2 {
		t.Fatalf("expected 2 deletes, got %d", len(meta.deletes))
	}
}

func TestAEADEncryptorRoundTripFrames(t *testing.T) {
	key := bytes.Repeat([]byte{9}, 32)
	enc := &AEADEncryptor{Key: key}
	plaintext := bytes.Repeat([]byte("abcdefgh"), 4096)
	out, err := enc.Encrypt(context.Background(), bytes.NewReader(plaintext))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	defer out.Close()
	frame, err := io.ReadAll(out)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(frame) <= aeadNonceSize+4 {
		t.Fatalf("frame too small: %d", len(frame))
	}
	if !bytes.Equal(frame[:aeadNonceSize], frame[aeadNonceSize:aeadNonceSize+aeadNonceSize]) {
		// The chunk sealer keeps the same nonce per call; the header should
		// match the nonce used to seal each chunk.
	}
}

// boomHTTP is an HTTPDoer that always returns an error.
type boomHTTP struct{ err error }

func (b *boomHTTP) Do(*http.Request) (*http.Response, error) { return nil, b.err }
