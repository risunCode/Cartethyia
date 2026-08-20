package models

import (
	"time"

	"github.com/cartethyia/daemon/internal/router/batch"
)

// BatchJob is the durable storage projection of a batch.Job. Key is kept
// alongside the lifecycle envelope because it is required to recover grouping
// decisions after a process restart.
type BatchJob struct {
	batch.Job
	Key       batch.Key
	Failure   *batch.Failure
	Progress  int
	UpdatedAt time.Time
}

// BatchItem is the durable storage projection of a batch.Item. Result is
// stored independently from the request identity so completed items remain
// visible when a job is partially successful.
type BatchItem struct {
	batch.Item
	Result    *batch.Result
	Error     string
	Progress  int
	UpdatedAt time.Time
	CreatedAt time.Time
}
