package load

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Call is the original, intentionally small request hook. Run adapts it to
// the richer Scenario API, so existing package users do not need to change.
type Call func(context.Context) error

// RequestCall is a bounded local request fixture. The index is stable for the
// duration of one run and can be used by a fixture to deterministically
// inject contention, provider failures, outages, latency, cancellation, and
// restart events.
type RequestCall func(context.Context, int) CallResult

// ResourceSampler supplies process/fixture resource observations. RSS,
// file-descriptor, and connection values are deliberately supplied by the
// caller because their portable sources differ between operating systems.
// The default sampler still reports heap and goroutine usage.
type ResourceSampler func() ResourceSnapshot

type Config struct {
	Workers  int
	Requests int
	Timeout  time.Duration

	// RequestTimeout bounds each individual callback. A zero value uses the
	// overall Timeout; it never creates a callback without a deadline.
	RequestTimeout time.Duration
	// MaxWorkers, MaxRequests, and MaxInFlight are hard safety limits. Zero
	// values use the package defaults.
	MaxWorkers  int
	MaxRequests int
	MaxInFlight int
	// SampleInterval enables bounded resource sampling while requests run.
	// Zero samples at start, after each request, and at completion.
	SampleInterval time.Duration
	Resources      ResourceSampler
}

const (
	DefaultMaxWorkers  = 64
	DefaultMaxRequests = 10_000
	DefaultMaxInFlight = 64
)

// Code is the stable machine-readable error namespace owned by this package.
type Code string

const (
	CodeInvalid  Code = "load.invalid"
	CodeLimit    Code = "load.limit"
	CodeCanceled Code = "load.canceled"
	CodeTimeout  Code = "load.timeout"
	CodeCall     Code = "load.call"
	CodePanic    Code = "load.panic"
	CodeRejected Code = "load.rejected"
)

// Error is returned for harness setup and runtime failures. Request failures
// remain in Report.Errors and do not fail the harness itself.
type Error struct {
	Code Code
	Op   string
	Err  error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Err == nil {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}
func (e *Error) Unwrap() error { return e.Err }

func newError(code Code, op string, err error) error {
	return &Error{Code: code, Op: op, Err: err}
}

// CodeOf returns a stable code for a harness error or callback failure.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var le *Error
	if errors.As(err, &le) && le.Code != "" {
		return le.Code
	}
	if errors.Is(err, context.Canceled) {
		return CodeCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return CodeTimeout
	}
	// Callback errors are external to this package and must not leak an
	// unstable string into the report.
	return CodeCall
}

type CallKind string

const (
	KindSuccess  CallKind = "success"
	KindFailure  CallKind = "failure"
	KindRejected CallKind = "rejected"
	KindCanceled CallKind = "canceled"
)

// CallResult describes one completed callback invocation.
type CallResult struct {
	Err            error
	Kind           CallKind
	RetryCount     int
	Streamed       bool
	StreamDuration time.Duration
}

type Percentiles struct {
	Count int
	Min   time.Duration
	P50   time.Duration
	P95   time.Duration
	P99   time.Duration
	Max   time.Duration
}

type ResourceSnapshot struct {
	RSSBytes        uint64
	HeapBytes       uint64
	Goroutines      int
	FileDescriptors int
	Connections     int
	ActiveStreams   int
}

type ResourceReport struct {
	Initial ResourceSnapshot
	Peak    ResourceSnapshot
	Final   ResourceSnapshot
}

type StreamReport struct {
	Count    int
	Duration Percentiles
}

type Report struct {
	// Total and Offered retain the distinction between work assigned and the
	// configured offered load. Total is the number of callbacks attempted.
	Total      int
	Offered    int
	Success    int
	Failures   int
	Rejected   int
	Canceled   int
	Completed  int
	Duration   time.Duration
	Throughput float64
	Latency    Percentiles
	Errors     map[Code]int
	Retries    int
	Resources  ResourceReport
	Streams    StreamReport

	// Convenient aliases for dashboards that do not decode Resources.
	PeakRSSBytes        uint64
	PeakHeapBytes       uint64
	PeakGoroutines      int
	PeakFileDescriptors int
	PeakConnections     int
}

// Run executes the legacy callback with the bounded scenario runner.
func Run(ctx context.Context, cfg Config, call Call) (Report, error) {
	if call == nil {
		return Report{}, newError(CodeInvalid, "run", errors.New("call is required"))
	}
	return RunScenario(ctx, cfg, Scenario{
		Call: func(callCtx context.Context, _ int) CallResult {
			return CallResult{Err: call(callCtx)}
		},
	})
}

type Scenario struct {
	Call RequestCall
}

// RunScenario executes a local load profile with at most MaxWorkers goroutines
// and MaxInFlight callbacks. It records every attempted request, including
// rejected and canceled outcomes, and never starts work after its run context
// expires.
func RunScenario(ctx context.Context, cfg Config, scenario Scenario) (Report, error) {
	if ctx == nil {
		return Report{}, newError(CodeInvalid, "run", errors.New("context is required"))
	}
	if scenario.Call == nil {
		return Report{}, newError(CodeInvalid, "run", errors.New("scenario call is required"))
	}
	cfg, err := normalize(cfg)
	if err != nil {
		return Report{}, err
	}
	sampler := cfg.Resources
	if sampler == nil {
		sampler = DefaultResourceSampler
	}
	runCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	started := time.Now()

	collector := newCollector(sampler())
	var sampleStop chan struct{}
	var sampleDone sync.WaitGroup
	if cfg.SampleInterval > 0 {
		sampleStop = make(chan struct{})
		sampleDone.Add(1)
		go func() {
			defer sampleDone.Done()
			ticker := time.NewTicker(cfg.SampleInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					collector.sample(sampler())
				case <-sampleStop:
					return
				}
			}
		}()
	}

	var next atomic.Int32
	workerCount := cfg.Workers
	if workerCount > cfg.MaxWorkers {
		workerCount = cfg.MaxWorkers
	}
	limit := cfg.MaxInFlight
	if limit > workerCount {
		limit = workerCount
	}
	tokens := make(chan struct{}, limit)
	var group sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				index := int(next.Add(1)) - 1
				if index >= cfg.Requests {
					return
				}
				if runCtx.Err() != nil {
					collector.canceled(time.Since(started))
					return
				}
				select {
				case tokens <- struct{}{}:
				case <-runCtx.Done():
					collector.canceled(time.Since(started))
					return
				}
				requestStart := time.Now()
				requestCtx := runCtx
				var requestCancel context.CancelFunc
				if cfg.RequestTimeout > 0 {
					requestCtx, requestCancel = context.WithTimeout(runCtx, cfg.RequestTimeout)
				}
				result := invoke(requestCtx, scenario.Call, index)
				if requestCancel != nil {
					requestCancel()
				}
				<-tokens
				collector.record(result, time.Since(requestStart))
				collector.sample(sampler())
				if runCtx.Err() != nil {
					return
				}
			}
		}()
	}
	group.Wait()
	if sampleStop != nil {
		close(sampleStop)
		sampleDone.Wait()
	}
	collector.sample(sampler())
	report := collector.report(cfg.Requests, time.Since(started))

	if ctx.Err() != nil {
		return report, newError(CodeCanceled, "run", ctx.Err())
	}
	if runCtx.Err() != nil && report.Total < cfg.Requests {
		return report, newError(CodeTimeout, "run", runCtx.Err())
	}
	return report, nil
}

func normalize(cfg Config) (Config, error) {
	if cfg.Requests <= 0 {
		return Config{}, newError(CodeInvalid, "config", errors.New("requests must be positive"))
	}
	if cfg.MaxRequests <= 0 {
		cfg.MaxRequests = DefaultMaxRequests
	}
	if cfg.Requests > cfg.MaxRequests {
		return Config{}, newError(CodeLimit, "config", errors.New("requests exceed configured bound"))
	}
	if cfg.Workers <= 0 {
		cfg.Workers = 1
	}
	if cfg.MaxWorkers <= 0 {
		cfg.MaxWorkers = DefaultMaxWorkers
	}
	if cfg.Workers > cfg.MaxWorkers {
		return Config{}, newError(CodeLimit, "config", errors.New("workers exceed configured bound"))
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = time.Second
	}
	if cfg.RequestTimeout < 0 {
		return Config{}, newError(CodeInvalid, "config", errors.New("request timeout cannot be negative"))
	}
	if cfg.MaxInFlight <= 0 {
		cfg.MaxInFlight = cfg.Workers
	}
	if cfg.MaxInFlight > DefaultMaxInFlight {
		return Config{}, newError(CodeLimit, "config", errors.New("in-flight limit exceeds configured bound"))
	}
	if cfg.SampleInterval < 0 {
		return Config{}, newError(CodeInvalid, "config", errors.New("sample interval cannot be negative"))
	}
	return cfg, nil
}

func invoke(ctx context.Context, call RequestCall, index int) (result CallResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = CallResult{Kind: KindFailure, Err: newError(CodePanic, "call", fmt.Errorf("%v", recovered))}
		}
	}()
	result = call(ctx, index)
	if result.Kind == "" {
		switch {
		case result.Err == nil:
			result.Kind = KindSuccess
		case errors.Is(result.Err, context.Canceled), errors.Is(result.Err, context.DeadlineExceeded):
			result.Kind = KindCanceled
		default:
			result.Kind = KindFailure
		}
	}
	return result
}

func DefaultResourceSampler() ResourceSnapshot {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return ResourceSnapshot{
		HeapBytes:  mem.HeapAlloc,
		Goroutines: runtime.NumGoroutine(),
	}
}

type collector struct {
	mu                                                  sync.Mutex
	latency                                             []time.Duration
	streams                                             []time.Duration
	errors                                              map[Code]int
	initial                                             ResourceSnapshot
	peak                                                ResourceSnapshot
	final                                               ResourceSnapshot
	success, failures, rejected, canceledCount, retries int
}

func newCollector(initial ResourceSnapshot) *collector {
	return &collector{initial: initial, peak: initial, errors: make(map[Code]int)}
}
func (c *collector) sample(snapshot ResourceSnapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if snapshot.RSSBytes > c.peak.RSSBytes {
		c.peak.RSSBytes = snapshot.RSSBytes
	}
	if snapshot.HeapBytes > c.peak.HeapBytes {
		c.peak.HeapBytes = snapshot.HeapBytes
	}
	if snapshot.Goroutines > c.peak.Goroutines {
		c.peak.Goroutines = snapshot.Goroutines
	}
	if snapshot.FileDescriptors > c.peak.FileDescriptors {
		c.peak.FileDescriptors = snapshot.FileDescriptors
	}
	if snapshot.Connections > c.peak.Connections {
		c.peak.Connections = snapshot.Connections
	}
	if snapshot.ActiveStreams > c.peak.ActiveStreams {
		c.peak.ActiveStreams = snapshot.ActiveStreams
	}
	c.final = snapshot
}
func (c *collector) canceled(latency time.Duration) {
	c.mu.Lock()
	c.canceledCount++
	c.latency = append(c.latency, latency)
	c.errors[CodeCanceled]++
	c.mu.Unlock()
}
func (c *collector) record(result CallResult, latency time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.latency = append(c.latency, latency)
	c.retries += max(0, result.RetryCount)
	code := CodeOf(result.Err)
	switch result.Kind {
	case KindSuccess:
		c.success++
	case KindRejected:
		c.rejected++
		if code == "" || code == CodeCall {
			code = CodeRejected
		}
		c.errors[code]++
	case KindCanceled:
		c.canceledCount++
		if code == "" || code == CodeCall {
			code = CodeCanceled
		}
		c.errors[code]++
	default:
		c.failures++
		if code == "" {
			code = CodeCall
		}
		c.errors[code]++
	}
	if result.Streamed {
		c.streams = append(c.streams, result.StreamDuration)
	}
}
func (c *collector) report(offered int, duration time.Duration) Report {
	c.mu.Lock()
	defer c.mu.Unlock()
	errs := make(map[Code]int, len(c.errors))
	for code, count := range c.errors {
		errs[code] = count
	}
	report := Report{
		Total: len(c.latency), Offered: offered, Success: c.success,
		Failures: c.failures, Rejected: c.rejected, Canceled: c.canceledCount,
		Completed: c.success + c.failures + c.rejected + c.canceledCount,
		Duration:  duration, Throughput: float64(c.success+c.failures+c.rejected+c.canceledCount) / duration.Seconds(),
		Latency: summarize(c.latency), Errors: errs, Retries: c.retries,
		Resources: ResourceReport{Initial: c.initial, Peak: c.peak, Final: c.final},
		Streams:   StreamReport{Count: len(c.streams), Duration: summarize(c.streams)},
	}
	report.PeakRSSBytes = report.Resources.Peak.RSSBytes
	report.PeakHeapBytes = report.Resources.Peak.HeapBytes
	report.PeakGoroutines = report.Resources.Peak.Goroutines
	report.PeakFileDescriptors = report.Resources.Peak.FileDescriptors
	report.PeakConnections = report.Resources.Peak.Connections
	return report
}
func summarize(values []time.Duration) Percentiles {
	if len(values) == 0 {
		return Percentiles{}
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	percentile := func(p int) time.Duration {
		index := (len(sorted)*p+99)/100 - 1
		if index < 0 {
			index = 0
		}
		if index >= len(sorted) {
			index = len(sorted) - 1
		}
		return sorted[index]
	}
	return Percentiles{Count: len(sorted), Min: sorted[0], P50: percentile(50), P95: percentile(95), P99: percentile(99), Max: sorted[len(sorted)-1]}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
