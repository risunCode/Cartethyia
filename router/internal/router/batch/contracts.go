package batch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// State represents the lifecycle of a batch job.
type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateCompleted State = "completed"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
	StateExpired   State = "expired"
)

// ItemState represents the lifecycle of one batch item.
type ItemState string

const (
	ItemQueued    ItemState = "queued"
	ItemRunning   ItemState = "running"
	ItemCompleted ItemState = "completed"
	ItemFailed    ItemState = "failed"
	ItemCancelled ItemState = "cancelled"
	ItemExpired   ItemState = "expired"
)

// Key identifies a compatibility-safe batch grouping.
type Key struct {
	ProviderID        string
	CapabilityVersion uint64
	Model             string
	Surface           contracts.Surface
	Endpoint          string
	AccountScope      string
	NetworkID         string
	ResponseMode      string
	ToolSchemaDigest  string
	PolicyDigest      string
	CatalogGeneration uint64
	TranslationDigest string
}

// BatchKey is retained as a descriptive name for callers that deal with
// routing keys. It is an alias, not a second compatibility contract.
type BatchKey = Key

// Compatible reports whether two requests can share a native batch. Every
// routing dimension is significant; in particular capability and translation
// generations are never ignored or normalized.
func (k Key) Compatible(other Key) bool { return k == other }

// CompatibleKeys is the function form for grouping and admission callers.
func CompatibleKeys(left, right Key) bool { return left.Compatible(right) }

// Validate ensures the key is bounded and complete enough to keep grouping
// safe. It intentionally rejects empty required identity fields rather than
// guessing a default grouping.
func (k Key) Validate() error {
	if strings.TrimSpace(k.ProviderID) == "" {
		return errors.New("batch: provider id is required")
	}
	if strings.TrimSpace(k.Model) == "" {
		return errors.New("batch: model is required")
	}
	if strings.TrimSpace(string(k.Surface)) == "" {
		return errors.New("batch: surface is required")
	}
	if k.CapabilityVersion == 0 {
		return errors.New("batch: capability version is required")
	}
	if k.CatalogGeneration == 0 {
		return errors.New("batch: catalog generation is required")
	}
	return nil
}

// Job is the durable envelope for a batch submission.
type Job struct {
	ID        string
	State     State
	CreatedAt time.Time
	ExpiresAt time.Time
	ItemCount int
}

// Item tracks one request within a durable batch job.
type Item struct {
	ID        string
	JobID     string
	Position  int
	RequestID string
	State     ItemState
}

// Result captures one completed item. It is intentionally small and
// request/response agnostic so storage and APIs can project their own DTOs
// later without changing the contract.
type Result struct {
	ItemID   string
	State    ItemState
	Error    string
	Response any
}

// Group is the submit-time unit a scheduler works with.
type Group struct {
	Key   Key
	Job   Job
	Items []Item
}

// Progress is the bounded job summary projected by APIs and workers.
type Progress struct {
	Job       Job
	State     State
	Total     int
	Queued    int
	Running   int
	Completed int
	Failed    int
	Cancelled int
	Expired   int
	Results   []Result
	Failure   *Failure
	UpdatedAt time.Time
}

// Service is the narrow API surface used by gateway and console handlers.
// It intentionally mirrors the user-visible batch lifecycle and hides the
// underlying repository/worker composition.
type Service interface {
	Submit(context.Context, Group) (Job, error)
	Get(context.Context, string) (Job, []Item, error)
	List(context.Context, State, int) ([]Job, error)
	Cancel(context.Context, string) (Job, error)
	Progress(context.Context, string) (Progress, error)
}

// Failure is a bounded batch-level error classification.
type Failure struct {
	Reason string
}

func (f Failure) Error() string {
	if strings.TrimSpace(f.Reason) == "" {
		return "batch: failure"
	}
	return fmt.Sprintf("batch: %s", f.Reason)
}
