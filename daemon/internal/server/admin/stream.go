package admin

import (
	"encoding/json"
	"net/http"
	"time"
)

// Admin-plane SSE plumbing.
//
// Streams are long-lived GET responses that flush each event immediately and
// refresh the connection write deadline per event so the server's global
// write timeout never cuts a healthy stream. The audit response writer lets
// these responses pass through unbuffered once the first flush commits.

const (
	adminStreamWriteBudget = 30 * time.Second
	adminStreamInitLimit   = 100
	adminStreamTailLimit   = 200
)

// adminStreamTick is the tail/heartbeat interval; a var so tests can speed
// it up.
var adminStreamTick = 2 * time.Second

// adminStream is a started event-stream response.
type adminStream struct {
	writer     http.ResponseWriter
	flusher    http.Flusher
	controller *http.ResponseController
}

// beginAdminStream writes the event-stream headers and the first deadline
// window. ok=false means the transport cannot stream (already answered).
func beginAdminStream(w http.ResponseWriter) (*adminStream, bool) {
	flusher, canFlush := w.(http.Flusher)
	if !canFlush {
		WriteError(w, NewError(CodeUnavailable, "stream_unavailable"))
		return nil, false
	}
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	header.Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(adminStreamWriteBudget))
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return &adminStream{writer: w, flusher: flusher, controller: controller}, true
}

// writeEvent frames one default-channel SSE event (clients receive it through
// EventSource.onmessage) and refreshes the write deadline before flushing.
func (s *adminStream) writeEvent(payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = s.writer.Write(append(append([]byte("data: "), encoded...), '\n', '\n'))
	_ = s.controller.SetWriteDeadline(time.Now().Add(adminStreamWriteBudget))
	s.flusher.Flush()
}
