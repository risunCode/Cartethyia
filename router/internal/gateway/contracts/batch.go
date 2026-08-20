package apicontracts

import (
	"time"

	"github.com/cartethyia/daemon/internal/router/batch"
)

// BatchSubmitRequest is the public batch submission body. Request payloads
// contain only bounded request identities; model request bodies remain owned by
// the dispatch protocol and are never accepted by this lifecycle API.
type BatchSubmitRequest struct {
	Key   batch.Key   `json:"key"`
	Items []batch.Item `json:"items"`
}

// BatchJob is the operator-safe/public projection of a durable batch job.
type BatchJob struct {
	ID        string    `json:"id"`
	State     batch.State `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	ItemCount int       `json:"itemCount"`
}

// BatchItem is the bounded projection of one item in a batch job.
type BatchItem struct {
	ID        string          `json:"id"`
	JobID     string          `json:"jobId"`
	Position  int             `json:"position"`
	RequestID string          `json:"requestId"`
	State     batch.ItemState `json:"state"`
}

// BatchProgress is the lifecycle summary returned by the progress endpoint.
type BatchProgress struct {
	JobID     string    `json:"jobId"`
	State     batch.State `json:"state"`
	Total     int       `json:"total"`
	Completed int       `json:"completed"`
	Failed    int       `json:"failed"`
	Pending   int       `json:"pending"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type BatchListResponse struct {
	Object string     `json:"object"`
	Data   []BatchJob `json:"data"`
}

type BatchGetResponse struct {
	Job   BatchJob   `json:"job"`
	Items []BatchItem `json:"items"`
}
