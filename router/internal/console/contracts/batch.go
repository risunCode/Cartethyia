package contracts

import (
	"time"

	"github.com/cartethyia/daemon/internal/router/batch"
)

// BatchSubmitRequest is the operator batch submission body. It carries
// grouping metadata and bounded item identities, never prompt or credential
// material.
type BatchSubmitRequest struct {
	Key   batch.Key    `json:"key"`
	Items []batch.Item `json:"items"`
}

type BatchJob struct {
	ID        string      `json:"id"`
	State     batch.State `json:"state"`
	CreatedAt time.Time   `json:"createdAt"`
	ExpiresAt time.Time   `json:"expiresAt"`
	ItemCount int         `json:"itemCount"`
}

type BatchItem struct {
	ID        string          `json:"id"`
	JobID     string          `json:"jobId"`
	Position  int             `json:"position"`
	RequestID string          `json:"requestId"`
	State     batch.ItemState `json:"state"`
}

type BatchProgress struct {
	JobID     string      `json:"jobId"`
	State     batch.State `json:"state"`
	Total     int         `json:"total"`
	Completed int         `json:"completed"`
	Failed    int         `json:"failed"`
	Pending   int         `json:"pending"`
	UpdatedAt time.Time   `json:"updatedAt"`
}

type BatchListResponse struct {
	Object string     `json:"object"`
	Data   []BatchJob `json:"data"`
}

type BatchGetResponse struct {
	Job   BatchJob    `json:"job"`
	Items []BatchItem `json:"items"`
}
