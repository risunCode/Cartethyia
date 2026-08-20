package batch

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// SchedulerConfig bounds the scheduler's in-memory admission queue. Durable
// persistence belongs to a repository, not to this package.
type SchedulerConfig struct {
	// MaxJobs and MaxItems bound queued work. A non-positive value selects a
	// conservative default.
	MaxJobs  int
	MaxItems int
	// MaxGroups bounds distinct compatibility keys in the queue.
	MaxGroups int
	// MaxItemsPerGroup bounds a submitted group.
	MaxItemsPerGroup int
	// MaxRunning bounds jobs that have been handed to workers.
	MaxRunning int

	// Capability, when supplied, is an advisory provider capability lookup.
	// It never rejects admission: workers own native-vs-fallback execution.
	Capability func(Key) bool
	// SupportsBatch is a compatibility spelling for advisory capability
	// registries that expose a direct provider decision.
	SupportsBatch func(Key) bool
	// Now makes expiry deterministic in callers and tests.
	Now func() time.Time
}

// Config is an alias for users that prefer the package's short configuration
// name. It does not introduce a second configuration type.
type Config = SchedulerConfig

const (
	defaultMaxJobs          = 1024
	defaultMaxItems         = 10000
	defaultMaxGroups        = 256
	defaultMaxItemsPerGroup = 1024
	defaultMaxRunning       = 128
)

var (
	ErrClosed      = errors.New("batch: scheduler is closed")
	ErrInvalid     = errors.New("batch: invalid group")
	ErrCapacity    = errors.New("batch: queue capacity exceeded")
	ErrUnsupported = errors.New("batch: provider does not support batch")
	ErrNotFound    = errors.New("batch: job not found")
	ErrExpired     = errors.New("batch: job expired")
	ErrCancelled   = errors.New("batch: job cancelled")
	ErrQueueEmpty  = errors.New("batch: queue is empty")
	ErrRunningCap  = errors.New("batch: running capacity exceeded")
)

// ProgressSnapshot is an alias useful to API owners naming response models.
type ProgressSnapshot = Progress

type scheduledJob struct {
	group   Group
	state   State
	items   []Item
	results map[string]Result
	failure *Failure
}

type queuedKey struct {
	key  Key
	jobs []*scheduledJob
}

// Scheduler performs admission, compatibility bucketing, and lifecycle
// transitions. It never executes provider calls and never persists data.
type Scheduler struct {
	mu sync.Mutex

	cfg SchedulerConfig

	jobs map[string]*scheduledJob
	keys map[Key]*queuedKey
	order []*queuedKey

	queuedJobs  int
	queuedItems int
	runningJobs int
	closed      bool
	changed     chan struct{}
}

// BatchScheduler is an explicit alias for integrations that name the
// component rather than its package.
type BatchScheduler = Scheduler

// BatchSchedulerConfig is the corresponding descriptive configuration alias.
type BatchSchedulerConfig = SchedulerConfig

// NewScheduler creates a bounded scheduler. Configuration is clamped to safe
// positive defaults; callers cannot accidentally create an unbounded queue.
func NewScheduler(cfg SchedulerConfig) *Scheduler {
	if cfg.MaxJobs <= 0 {
		cfg.MaxJobs = defaultMaxJobs
	}
	if cfg.MaxItems <= 0 {
		cfg.MaxItems = defaultMaxItems
	}
	if cfg.MaxGroups <= 0 {
		cfg.MaxGroups = defaultMaxGroups
	}
	if cfg.MaxItemsPerGroup <= 0 {
		cfg.MaxItemsPerGroup = defaultMaxItemsPerGroup
	}
	if cfg.MaxRunning <= 0 {
		cfg.MaxRunning = defaultMaxRunning
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Scheduler{
		cfg:     cfg,
		jobs:    make(map[string]*scheduledJob),
		keys:    make(map[Key]*queuedKey),
		changed: make(chan struct{}),
	}
}

// New is a convenience constructor using safe defaults.
func New() *Scheduler { return NewScheduler(SchedulerConfig{}) }

func (s *Scheduler) now() time.Time {
	if s.cfg.Now == nil {
		return time.Now()
	}
	return s.cfg.Now()
}

// Submit admits one durable group into the bounded scheduler. Groups sharing
// the exact Key are placed in one deterministic compatibility bucket; keys are
// compared structurally, including capability and translation digests.
func (s *Scheduler) Submit(ctx context.Context, group Group) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateGroup(group, s.cfg.MaxItemsPerGroup, s.now()); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if _, exists := s.jobs[group.Job.ID]; exists {
		return fmt.Errorf("%w: duplicate job id", ErrInvalid)
	}
	if s.queuedJobs >= s.cfg.MaxJobs ||
		s.queuedItems+len(group.Items) > s.cfg.MaxItems {
		return ErrCapacity
	}
	bucket := s.keys[group.Key]
	if bucket == nil {
		if len(s.keys) >= s.cfg.MaxGroups {
			return ErrCapacity
		}
		bucket = &queuedKey{key: group.Key}
		s.keys[group.Key] = bucket
		s.order = append(s.order, bucket)
	}
	entry := &scheduledJob{
		group:   cloneGroup(group),
		state:   StateQueued,
		items:   cloneItems(group.Items),
		results: make(map[string]Result, len(group.Items)),
	}
	entry.group.Job.State = StateQueued
	for i := range entry.items {
		if !terminalItem(entry.items[i].State) {
			entry.items[i].State = ItemQueued
		}
	}
	entry.group.Items = cloneItems(entry.items)
	s.jobs[group.Job.ID] = entry
	bucket.jobs = append(bucket.jobs, entry)
	s.queuedJobs++
	s.queuedItems += len(group.Items)
	s.signalLocked()
	return nil
}

// Accept is a spelling used by admission callers.
func (s *Scheduler) Accept(ctx context.Context, group Group) error {
	return s.Submit(ctx, group)
}

// Next waits for and claims the oldest eligible queued job. Eligibility is
// deterministic: creation time, then job ID, then item position/ID. A claim
// consumes running capacity and changes the job and its items to running.
func (s *Scheduler) Next(ctx context.Context) (Group, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		if err := ctx.Err(); err != nil {
			return Group{}, err
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return Group{}, ErrClosed
		}
		s.expireLocked(s.now())
		if s.runningJobs < s.cfg.MaxRunning {
			if entry := s.nextLocked(); entry != nil {
				entry.state = StateRunning
				entry.group.Job.State = StateRunning
				for i := range entry.items {
					if !terminalItem(entry.items[i].State) {
						entry.items[i].State = ItemRunning
					}
				}
				entry.group.Items = cloneItems(entry.items)
				s.queuedJobs--
				s.queuedItems -= len(entry.items)
				s.runningJobs++
				s.signalLocked()
				group := cloneGroup(entry.group)
				s.mu.Unlock()
				return group, nil
			}
		}
		wait := s.changed
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return Group{}, ctx.Err()
		case <-wait:
		}
	}
}

// Dequeue is an alias for Next.
func (s *Scheduler) Dequeue(ctx context.Context) (Group, error) {
	return s.Next(ctx)
}

func (s *Scheduler) nextLocked() *scheduledJob {
	var best *scheduledJob
	var bestBucket *queuedKey
	bestAt := -1
	for i, bucket := range s.order {
		for _, candidate := range bucket.jobs {
			if candidate.state != StateQueued {
				continue
			}
			if best == nil || lessJob(candidate.group.Job, best.group.Job) {
				best, bestBucket, bestAt = candidate, bucket, i
			}
		}
	}
	if best == nil {
		return nil
	}
	for i, candidate := range bestBucket.jobs {
		if candidate == best {
			bestBucket.jobs = append(bestBucket.jobs[:i], bestBucket.jobs[i+1:]...)
			break
		}
	}
	if len(bestBucket.jobs) == 0 {
		delete(s.keys, bestBucket.key)
		s.order = append(s.order[:bestAt], s.order[bestAt+1:]...)
	}
	return best
}

func lessJob(a, b Job) bool {
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.Before(b.CreatedAt)
	}
	return a.ID < b.ID
}

// Cancel transitions a queued or running job and all non-terminal items to
// cancelled. Cancellation is idempotent for terminal jobs.
func (s *Scheduler) Cancel(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.jobs[jobID]
	if !ok {
		return ErrNotFound
	}
	if terminal(entry.state) {
		return nil
	}
	if entry.state == StateQueued {
		s.removeQueuedLocked(entry)
		s.queuedJobs--
		s.queuedItems -= len(entry.items)
	} else if entry.state == StateRunning {
		s.runningJobs--
	}
	entry.state = StateCancelled
	entry.group.Job.State = StateCancelled
	for i := range entry.items {
		if !terminalItem(entry.items[i].State) {
			entry.items[i].State = ItemCancelled
		}
	}
	s.signalLocked()
	return nil
}

// Expire transitions every queued or running job whose deadline has passed.
// It returns job IDs in deterministic order.
func (s *Scheduler) Expire(now time.Time) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.IsZero() {
		now = s.now()
	}
	ids := s.expireLocked(now)
	if len(ids) > 1 {
		sort.Strings(ids)
	}
	return ids
}

// ExpireJobs is an alias for Expire.
func (s *Scheduler) ExpireJobs(now time.Time) []string { return s.Expire(now) }

func (s *Scheduler) expireLocked(now time.Time) []string {
	ids := make([]string, 0)
	for _, entry := range s.jobs {
		if terminal(entry.state) || entry.group.Job.ExpiresAt.IsZero() ||
			entry.group.Job.ExpiresAt.After(now) {
			continue
		}
		if entry.state == StateQueued {
			s.removeQueuedLocked(entry)
			s.queuedJobs--
			s.queuedItems -= len(entry.items)
		} else if entry.state == StateRunning {
			s.runningJobs--
		}
		entry.state = StateExpired
		entry.group.Job.State = StateExpired
		for i := range entry.items {
			if !terminalItem(entry.items[i].State) {
				entry.items[i].State = ItemExpired
			}
		}
		ids = append(ids, entry.group.Job.ID)
	}
	if len(ids) > 0 {
		s.signalLocked()
	}
	return ids
}

// Complete records worker results and closes a running job. Missing item
// results are marked failed, avoiding jobs that remain running forever.
func (s *Scheduler) Complete(jobID string, results []Result) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.jobs[jobID]
	if !ok {
		return ErrNotFound
	}
	if entry.state == StateCancelled {
		return ErrCancelled
	}
	if entry.state == StateExpired {
		return ErrExpired
	}
	if entry.state != StateRunning {
		return fmt.Errorf("%w: job is not running", ErrInvalid)
	}
	itemIDs := make(map[string]struct{}, len(entry.items))
	for _, item := range entry.items {
		itemIDs[item.ID] = struct{}{}
	}
	for _, result := range results {
		if _, known := itemIDs[result.ItemID]; !known {
			return fmt.Errorf("%w: unknown item result", ErrInvalid)
		}
		if result.State != ItemCompleted && result.State != ItemFailed &&
			result.State != ItemCancelled && result.State != ItemExpired {
			return fmt.Errorf("%w: non-terminal item result", ErrInvalid)
		}
		if _, exists := entry.results[result.ItemID]; !exists {
			entry.results[result.ItemID] = cloneResult(result)
		}
	}
	for i := range entry.items {
		if result, ok := entry.results[entry.items[i].ID]; ok {
			entry.items[i].State = result.State
		} else if !terminalItem(entry.items[i].State) {
			entry.items[i].State = ItemFailed
			entry.results[entry.items[i].ID] = Result{
				ItemID: entry.items[i].ID, State: ItemFailed,
				Error: "batch: missing worker result",
			}
		}
	}
	entry.state = StateCompleted
	for _, item := range entry.items {
		if item.State == ItemFailed {
			entry.state = StateFailed
			break
		}
		if item.State == ItemCancelled {
			entry.state = StateCancelled
		} else if item.State == ItemExpired && entry.state == StateCompleted {
			entry.state = StateExpired
		}
	}
	entry.group.Job.State = entry.state
	s.runningJobs--
	s.signalLocked()
	return nil
}

// Report is the worker-facing completion spelling.
func (s *Scheduler) Report(jobID string, results []Result) error {
	return s.Complete(jobID, results)
}

// Fail closes a running job with a bounded batch-level failure.
func (s *Scheduler) Fail(jobID string, failure Failure) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.jobs[jobID]
	if !ok {
		return ErrNotFound
	}
	if entry.state == StateCancelled {
		return ErrCancelled
	}
	if entry.state == StateExpired {
		return ErrExpired
	}
	if entry.state != StateRunning {
		return fmt.Errorf("%w: job is not running", ErrInvalid)
	}
	entry.failure = &Failure{Reason: boundedReason(failure.Reason)}
	entry.state = StateFailed
	entry.group.Job.State = StateFailed
	for i := range entry.items {
		if !terminalItem(entry.items[i].State) {
			entry.items[i].State = ItemFailed
		}
	}
	s.runningJobs--
	s.signalLocked()
	return nil
}

// Progress returns a defensive point-in-time view of one job.
func (s *Scheduler) Progress(jobID string) (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.jobs[jobID]
	if !ok {
		return Progress{}, ErrNotFound
	}
	return progressOf(entry), nil
}

// GetProgress is an alias for Progress.
func (s *Scheduler) GetProgress(jobID string) (Progress, error) {
	return s.Progress(jobID)
}

// Close rejects new work and wakes blocked workers. Existing durable records
// remain available through Progress and are not silently discarded.
func (s *Scheduler) Close() {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		s.signalLocked()
	}
	s.mu.Unlock()
}

// Len reports queued jobs and is intentionally independent of running work.
func (s *Scheduler) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.queuedJobs
}

// Running reports currently claimed jobs.
func (s *Scheduler) Running() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runningJobs
}

// Jobs returns queued, running, and terminal jobs ordered by creation time and
// then ID. It is a scheduler snapshot, not a durable listing.
func (s *Scheduler) Jobs() []Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Job, 0, len(s.jobs))
	for _, entry := range s.jobs {
		out = append(out, cloneJob(entry.group.Job))
	}
	sort.Slice(out, func(i, j int) bool { return lessJob(out[i], out[j]) })
	return out
}

// Groups returns queued groups in the same deterministic order used by Next.
func (s *Scheduler) Groups() []Group {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Group, 0, s.queuedJobs)
	for _, entry := range s.jobs {
		if entry.state == StateQueued {
			out = append(out, cloneGroup(entry.group))
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessJob(out[i].Job, out[j].Job) })
	return out
}

// TryNext claims a queued group without waiting.
func (s *Scheduler) TryNext() (Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Group{}, ErrClosed
	}
	s.expireLocked(s.now())
	if s.runningJobs >= s.cfg.MaxRunning {
		return Group{}, ErrRunningCap
	}
	entry := s.nextLocked()
	if entry == nil {
		return Group{}, ErrQueueEmpty
	}
	entry.state = StateRunning
	entry.group.Job.State = StateRunning
	for i := range entry.items {
		if !terminalItem(entry.items[i].State) {
			entry.items[i].State = ItemRunning
		}
	}
	entry.group.Items = cloneItems(entry.items)
	s.queuedJobs--
	s.queuedItems -= len(entry.items)
	s.runningJobs++
	s.signalLocked()
	return cloneGroup(entry.group), nil
}

func (s *Scheduler) removeQueuedLocked(entry *scheduledJob) {
	for key, bucket := range s.keys {
		for i, candidate := range bucket.jobs {
			if candidate != entry {
				continue
			}
			bucket.jobs = append(bucket.jobs[:i], bucket.jobs[i+1:]...)
			if len(bucket.jobs) == 0 {
				delete(s.keys, key)
				for j, ordered := range s.order {
					if ordered == bucket {
						s.order = append(s.order[:j], s.order[j+1:]...)
						break
					}
				}
			}
			return
		}
	}
}

func (s *Scheduler) signalLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func validateGroup(group Group, maxItems int, now time.Time) error {
	if err := group.Key.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if strings.TrimSpace(group.Job.ID) == "" || group.Job.ItemCount != len(group.Items) ||
		len(group.Items) == 0 || len(group.Items) > maxItems {
		return fmt.Errorf("%w: item count or job id is invalid", ErrInvalid)
	}
	if !group.Job.ExpiresAt.IsZero() && !group.Job.ExpiresAt.After(now) {
		return ErrExpired
	}
	seen := make(map[string]struct{}, len(group.Items))
	for i, item := range group.Items {
		if item.ID == "" || item.JobID != group.Job.ID || item.Position != i {
			return fmt.Errorf("%w: item identity or position is invalid", ErrInvalid)
		}
		if _, ok := seen[item.ID]; ok {
			return fmt.Errorf("%w: duplicate item id", ErrInvalid)
		}
		seen[item.ID] = struct{}{}
	}
	return nil
}

func terminal(state State) bool {
	return state == StateCompleted || state == StateFailed ||
		state == StateCancelled || state == StateExpired
}

func terminalItem(state ItemState) bool {
	return state == ItemCompleted || state == ItemFailed ||
		state == ItemCancelled || state == ItemExpired
}

func progressOf(entry *scheduledJob) Progress {
	p := Progress{
		Job: cloneJob(entry.group.Job), State: entry.state,
		Total: len(entry.items), Results: make([]Result, 0, len(entry.results)),
	}
	for _, item := range entry.items {
		switch item.State {
		case ItemQueued:
			p.Queued++
		case ItemRunning:
			p.Running++
		case ItemCompleted:
			p.Completed++
		case ItemFailed:
			p.Failed++
		case ItemCancelled:
			p.Cancelled++
		case ItemExpired:
			p.Expired++
		}
	}
	for _, result := range entry.results {
		p.Results = append(p.Results, cloneResult(result))
	}
	sort.Slice(p.Results, func(i, j int) bool { return p.Results[i].ItemID < p.Results[j].ItemID })
	if entry.failure != nil {
		f := *entry.failure
		p.Failure = &f
	}
	return p
}

func boundedReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if len(reason) > 256 {
		return reason[:256]
	}
	return reason
}

func cloneJob(job Job) Job { return job }

func cloneItems(items []Item) []Item {
	out := make([]Item, len(items))
	copy(out, items)
	return out
}

func cloneGroup(group Group) Group {
	group.Job = cloneJob(group.Job)
	group.Items = cloneItems(group.Items)
	return group
}

func cloneResult(result Result) Result { return result }
