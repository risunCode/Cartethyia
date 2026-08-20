package batch

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/cartethyia/daemon/internal/providers"
)

const (
	// DefaultParallelism bounds the number of individual requests issued by a
	// fallback execution. Batch workers deliberately do not share the router's
	// retry or account-selection budget.
	DefaultParallelism = 4
	// MaxParallelism prevents a malformed or untrusted configuration from
	// turning one batch into an unbounded fan-out.
	MaxParallelism = 32
)

// IndividualDispatch is the already-routed, one-item execution seam. The
// caller owns request reconstruction, account/network isolation, and the
// router's normal attempt policy; a worker only bounds concurrency.
type IndividualDispatch func(context.Context, Item) (Result, error)

// NativeBatchExecutor is implemented by a provider integration that has a
// verified native asynchronous batch surface. Results MUST be keyed by the
// durable Item.ID rather than input position.
type NativeBatchExecutor interface {
	ExecuteBatch(context.Context, Key, []Item) (map[string]Result, error)
}

// Executor runs a scheduled Group. Native execution is selected only when the
// resolved provider (and, when present, its model override) advertises Batch.
// Groups for providers without that capability use bounded individual
// dispatches instead.
type Executor struct {
	Provider    providers.Provider
	Native      NativeBatchExecutor
	Dispatch    IndividualDispatch
	MaxParallel int
	// Caps is an optional capability snapshot for callers that resolve a
	// provider outside this package. Provider capabilities take precedence.
	Caps *providers.ProviderCaps
}

// Worker is the descriptive spelling used by scheduler integrations.
type Worker = Executor

// NewExecutor constructs a worker executor with the default bounded fan-out.
func NewExecutor(provider providers.Provider, dispatch IndividualDispatch) *Executor {
	return &Executor{
		Provider:    provider,
		Dispatch:    dispatch,
		MaxParallel: DefaultParallelism,
	}
}

// NewWorker is an explicit constructor alias for callers that name the
// execution component rather than the execution operation.
func NewWorker(provider providers.Provider, dispatch IndividualDispatch) *Executor {
	return NewExecutor(provider, dispatch)
}

// Execute processes every item in group order and returns one deterministic
// result per durable item. Item-level errors are preserved in Result rather
// than aborting the rest of the group. A non-nil error is reserved for an
// invalid group, missing dispatch seam, or native provider failure.
func (e *Executor) Execute(ctx context.Context, group Group) ([]Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	items, err := validateItems(group)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return []Result{}, nil
	}
	active := make([]Item, 0, len(items))
	preset := make(map[string]Result)
	for _, item := range items {
		switch item.State {
		case ItemCompleted, ItemFailed, ItemCancelled, ItemExpired:
			preset[item.ID] = Result{ItemID: item.ID, State: item.State}
		default:
			active = append(active, item)
		}
	}
	results := make([]Result, len(items))
	if len(active) == 0 {
		for i, item := range items {
			results[i] = preset[item.ID]
		}
		return results, nil
	}
	if err := ctx.Err(); err != nil {
		for i := range items {
			if result, ok := preset[items[i].ID]; ok {
				results[i] = result
			} else {
				results[i] = cancelledResult(items[i].ID, err)
			}
		}
		return results, nil
	}

	if native := e.nativeExecutor(group.Key); native != nil {
		executed, executeErr := e.executeNative(ctx, group.Key, active, native)
		return mergeResults(items, results, preset, executed), executeErr
	}
	executed, executeErr := e.executeFallback(ctx, active)
	return mergeResults(items, results, preset, executed), executeErr
}

// Run is the worker-facing spelling of Execute.
func (e *Executor) Run(ctx context.Context, group Group) ([]Result, error) {
	return e.Execute(ctx, group)
}

func (e *Executor) nativeExecutor(key Key) NativeBatchExecutor {
	if e == nil {
		return nil
	}
	if !e.batchSupported(key) {
		return nil
	}
	if e.Native != nil {
		return e.Native
	}
	if native, ok := e.Provider.(NativeBatchExecutor); ok {
		return native
	}
	return nil
}

func (e *Executor) batchSupported(key Key) bool {
	if e == nil {
		return false
	}
	caps := e.Caps
	if e.Provider != nil {
		snapshot := e.Provider.Capabilities()
		caps = &snapshot
		if catalog := e.Provider.Models(); catalog != nil {
			if model := catalog.Get(key.Model); model != nil && model.Capabilities != nil {
				caps = model.Capabilities
			}
		}
	}
	return caps != nil && caps.Batch
}

func (e *Executor) executeNative(ctx context.Context, key Key, items []Item, native NativeBatchExecutor) ([]Result, error) {
	raw, err := safeNativeExecute(ctx, native, key, items)
	results := make([]Result, len(items))
	for i, item := range items {
		result, ok := raw[item.ID]
		if !ok {
			result = failedResult(item.ID, nativeFailure(err))
		} else {
			result = normalizeResult(item.ID, result)
		}
		results[i] = result
	}
	if err != nil {
		return results, err
	}
	return results, nil
}

func (e *Executor) executeFallback(ctx context.Context, items []Item) ([]Result, error) {
	if e == nil || e.Dispatch == nil {
		return nil, errors.New("batch: individual dispatch is not configured")
	}
	parallelism := e.MaxParallel
	if parallelism <= 0 {
		parallelism = DefaultParallelism
	}
	if parallelism > MaxParallelism {
		parallelism = MaxParallelism
	}
	if parallelism > len(items) {
		parallelism = len(items)
	}
	results := make([]Result, len(items))
	jobs := make(chan int)
	var wg sync.WaitGroup
	wg.Add(parallelism)
	for n := 0; n < parallelism; n++ {
		go func() {
			defer wg.Done()
			for index := range jobs {
				item := items[index]
				if ctxErr := ctx.Err(); ctxErr != nil {
					results[index] = cancelledResult(item.ID, ctxErr)
					continue
				}
				result, err := safeDispatch(ctx, e.Dispatch, item)
				if err != nil {
					result = failedResult(item.ID, err)
				} else {
					result = normalizeResult(item.ID, result)
				}
				results[index] = result
			}
		}()
	}
	for index := range items {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	return results, nil
}

func mergeResults(items []Item, results []Result, preset map[string]Result, executed []Result) []Result {
	byID := make(map[string]Result, len(executed))
	for _, result := range executed {
		byID[result.ItemID] = result
	}
	for i, item := range items {
		if result, ok := preset[item.ID]; ok {
			results[i] = result
			continue
		}
		if result, ok := byID[item.ID]; ok {
			results[i] = result
			continue
		}
		results[i] = failedResult(item.ID, errors.New("batch: missing worker result"))
	}
	return results
}

func validateItems(group Group) ([]Item, error) {
	if err := group.Key.Validate(); err != nil {
		return nil, err
	}
	items := append([]Item(nil), group.Items...)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Position != items[j].Position {
			return items[i].Position < items[j].Position
		}
		return items[i].ID < items[j].ID
	})
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.ID) == "" {
			return nil, errors.New("batch: item id is required")
		}
		if _, exists := seen[item.ID]; exists {
			return nil, fmt.Errorf("batch: duplicate item id %q", item.ID)
		}
		seen[item.ID] = struct{}{}
		if item.JobID != "" && group.Job.ID != "" && item.JobID != group.Job.ID {
			return nil, fmt.Errorf("batch: item %q belongs to job %q, not %q", item.ID, item.JobID, group.Job.ID)
		}
	}
	return items, nil
}

func normalizeResult(itemID string, result Result) Result {
	result.ItemID = itemID
	if result.Error != "" {
		result.State = ItemFailed
		return result
	}
	switch result.State {
	case ItemCompleted, ItemFailed, ItemCancelled, ItemExpired:
		return result
	default:
		result.State = ItemCompleted
		return result
	}
}

func failedResult(itemID string, err error) Result {
	return Result{ItemID: itemID, State: ItemFailed, Error: failureReason(err)}
}

func cancelledResult(itemID string, err error) Result {
	return Result{ItemID: itemID, State: ItemCancelled, Error: failureReason(err)}
}

func nativeFailure(err error) error {
	if err == nil {
		return errors.New("native batch omitted item result")
	}
	return err
}

func failureReason(err error) string {
	if err == nil {
		return ""
	}
	var failure Failure
	if errors.As(err, &failure) && strings.TrimSpace(failure.Reason) != "" {
		return strings.TrimSpace(failure.Reason)
	}
	var failurePtr *Failure
	if errors.As(err, &failurePtr) && failurePtr != nil && strings.TrimSpace(failurePtr.Reason) != "" {
		return strings.TrimSpace(failurePtr.Reason)
	}
	if reason := strings.TrimSpace(err.Error()); reason != "" {
		return reason
	}
	return "batch item failed"
}

func safeDispatch(ctx context.Context, dispatch IndividualDispatch, item Item) (result Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = Result{}
			err = fmt.Errorf("batch: item dispatch panic: %v", recovered)
		}
	}()
	return dispatch(ctx, item)
}

func safeNativeExecute(ctx context.Context, native NativeBatchExecutor, key Key, items []Item) (result map[string]Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			err = fmt.Errorf("batch: native execution panic: %v", recovered)
		}
	}()
	return native.ExecuteBatch(ctx, key, items)
}
