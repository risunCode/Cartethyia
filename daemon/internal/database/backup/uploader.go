package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// HTTPDoer is the minimum transport contract the uploader needs. The
// standard *http.Client satisfies it, so callers can inject one without
// pulling in extra packages.
type HTTPDoer interface {
	// Do executes a single round trip. The supplied request's Body is
	// consumed by Do; the caller MUST NOT reuse it. Implementations MUST
	// honour the request's Context for cancellation.
	Do(req *http.Request) (*http.Response, error)
}

// UploadResult is the observable outcome of a Telegram upload.
type UploadResult struct {
	// MessageID is the Telegram-assigned identifier of the delivered message.
	MessageID int64
	// ChatID echoes the destination chat used.
	ChatID int64
	// DocumentID is the Telegram file identifier for the uploaded document.
	DocumentID string
	// Size is the number of bytes transmitted.
	Size int64
}

// Uploader transfers a stream to the configured off-site destination.
//
// The interface is transport-agnostic so the orchestrator can swap providers
// without changing lifecycle code. Implementations are responsible for
// honouring ctx and returning a stage-tagged error on failure.
type Uploader interface {
	// Upload sends the stream and returns the delivery result. The reader is
	// fully consumed before the function returns.
	Upload(ctx context.Context, name string, body io.Reader, size int64) (UploadResult, error)
}

// TelegramUploader uploads a stream to a Telegram chat via the Bot API
// sendDocument endpoint. The endpoint host and token are supplied at
// construction time; no defaults are baked in.
type TelegramUploader struct {
	// Client is the HTTP transport. Required.
	Client HTTPDoer
	// BotToken is the Telegram Bot API token. Required and non-empty.
	BotToken string
	// ChatID is the destination chat. Required and non-zero.
	ChatID int64
	// Endpoint is the Telegram Bot API base URL, including scheme. Required.
	// Example: "https://api.telegram.org"
	Endpoint string
	// Caption, when non-empty, is attached as the document caption.
	Caption string
}

// Upload streams the document to the configured chat and returns the result.
func (u *TelegramUploader) Upload(ctx context.Context, name string, body io.Reader, size int64) (UploadResult, error) {
	if u == nil {
		return UploadResult{}, errors.New("backup: nil TelegramUploader")
	}
	if u.Client == nil {
		return UploadResult{}, errors.New("backup: TelegramUploader.Client is nil")
	}
	if strings.TrimSpace(u.BotToken) == "" {
		return UploadResult{}, errors.New("backup: TelegramUploader.BotToken is empty")
	}
	if u.ChatID == 0 {
		return UploadResult{}, errors.New("backup: TelegramUploader.ChatID is zero")
	}
	if strings.TrimSpace(u.Endpoint) == "" {
		return UploadResult{}, errors.New("backup: TelegramUploader.Endpoint is empty")
	}
	if body == nil {
		return UploadResult{}, errors.New("backup: nil upload body")
	}

	pipeReader, pipeWriter := io.Pipe()
	defer pipeReader.Close()
	writer := multipart.NewWriter(pipeWriter)
	errCh := make(chan error, 1)
	go func() {
		defer close(errCh)
		fail := func(err error) {
			_ = pipeWriter.CloseWithError(err)
			errCh <- err
		}
		if err := writer.WriteField("chat_id", strconv.FormatInt(u.ChatID, 10)); err != nil {
			fail(err)
			return
		}
		if u.Caption != "" {
			if err := writer.WriteField("caption", u.Caption); err != nil {
				fail(err)
				return
			}
		}
		part, err := writer.CreateFormFile("document", name)
		if err != nil {
			fail(err)
			return
		}
		if _, err := io.Copy(part, body); err != nil {
			fail(err)
			return
		}
		if err := writer.Close(); err != nil {
			fail(err)
			return
		}
		if err := pipeWriter.Close(); err != nil {
			errCh <- err
		}
	}()

	endpoint, err := u.buildSendDocumentURL()
	if err != nil {
		_ = pipeReader.CloseWithError(err)
		<-errCh
		return UploadResult{}, newStageError(StageUpload, 1, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, pipeReader)
	if err != nil {
		_ = pipeReader.CloseWithError(err)
		<-errCh
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("build request: %w", err))
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if size > 0 {
		req.ContentLength = computeContentLength(size, writer.Boundary(), u.Caption != "")
	}

	resp, err := u.Client.Do(req)
	if err != nil {
		_ = pipeReader.CloseWithError(err)
		<-errCh
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("http do: %w", err))
	}
	defer resp.Body.Close()
	buildErr := <-errCh
	if buildErr != nil {
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("build multipart: %w", buildErr))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("telegram status %d", resp.StatusCode))
	}

	var payload telegramResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("decode response: %w", err))
	}
	if !payload.OK {
		return UploadResult{}, newStageError(StageUpload, 1, fmt.Errorf("telegram error: %s", payload.Description))
	}
	if payload.Result == nil {
		return UploadResult{}, newStageError(StageUpload, 1, errors.New("telegram response missing result"))
	}
	result := UploadResult{
		MessageID: payload.Result.MessageID,
		ChatID:    payload.Result.Chat.ID,
		Size:      size,
	}
	if payload.Result.Document != nil {
		result.DocumentID = payload.Result.Document.FileID
	}
	return result, nil
}

func (u *TelegramUploader) buildSendDocumentURL() (string, error) {
	base := strings.TrimRight(u.Endpoint, "/")
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
	// Telegram bot tokens contain only ASCII alphanumerics, ':', '-', '_'.
	// Rejecting unexpected characters prevents us from emitting a malformed
	// URL.
	for _, r := range u.BotToken {
		ok := r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
		if !ok {
			return "", fmt.Errorf("bot token contains invalid character %q", r)
		}
	}
	return base + "/bot" + u.BotToken + "/sendDocument", nil
}

type telegramResponse struct {
	OK          bool             `json:"ok"`
	Description string           `json:"description"`
	Result      *telegramMessage `json:"result"`
}

type telegramMessage struct {
	MessageID int64         `json:"message_id"`
	Chat      *telegramChat `json:"chat"`
	Document  *telegramDoc  `json:"document"`
}

type telegramChat struct {
	ID int64 `json:"id"`
}

type telegramDoc struct {
	FileID string `json:"file_id"`
}

// computeContentLength estimates the multipart Content-Length so HTTP/1.1
// servers can stream the request without chunked encoding. The estimate uses
// the actual file size plus a conservative per-frame overhead.
func computeContentLength(size int64, boundary string, hasCaption bool) int64 {
	const perFieldOverhead = 64
	overhead := int64(len(boundary) + perFieldOverhead*4)
	if hasCaption {
		overhead += 64
	}
	return overhead + size
}
