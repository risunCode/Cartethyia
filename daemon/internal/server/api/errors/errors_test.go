package apierrors

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestWriteErrorPreservesPayloadTooLargeEnvelope(t *testing.T) {
	response := httptest.NewRecorder()
	WriteError(response, &contracts.RouteError{
		Kind:       contracts.ErrorInvalidRequest,
		Code:       "payload_too_large",
		StatusCode: http.StatusRequestEntityTooLarge,
		Message:    "request payload exceeds the maximum allowed size",
	})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d, want 413", response.Code)
	}
	var body Response
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != CodePayloadTooLarge || body.Error.Kind != CodePayloadTooLarge {
		t.Fatalf("error=%#v, want stable payload-too-large code and kind", body.Error)
	}
}
