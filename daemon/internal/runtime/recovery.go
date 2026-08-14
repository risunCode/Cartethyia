package runtime

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"
)

var ErrWorkerClosed = &Error{Code: CodeWorkerClosed, Op: "worker", Err: errors.New("worker group closed")}

// Probe is a bounded health check. Implementations must honor ctx and must not
type Probe func(context.Context) error
type RecoveryWorker struct {
	Name       string
	Probe      Probe
	Interval   time.Duration
	MaxBackoff time.Duration
	// ProbeTimeout bounds an individual probe. Zero uses Interval.
	ProbeTimeout time.Duration
	// Eligible suppresses probes while an operator quarantine/disable is active.
	// A nil function means eligible.
	Eligible func() bool
	// Invalidate publishes a new owner generation after a successful probe.
	Invalidate func(context.Context) error
	// OnSuccess and OnFailure publish the owning package's health state.
	OnSuccess func()
	OnFailure func(error)
}

type probeFlight struct {
	done chan struct{}
	err  error
}

type RecoveryGroup struct {
	mu       sync.Mutex
	workers  []RecoveryWorker
	byName   map[string]RecoveryWorker
	flights  map[string]*probeFlight
	cancel   context.CancelFunc
	ctx      context.Context
	done     chan struct{}
	workerWG sync.WaitGroup
	started  bool
}

func NewRecoveryGroup(workers ...RecoveryWorker) *RecoveryGroup {
	copied := append([]RecoveryWorker(nil), workers...)
	return &RecoveryGroup{workers: copied}
}

// Start starts each worker after validating the complete group. Starting is
// deterministic: workers are launched in declaration order and each performs
// an immediate probe. A group can be started again after Close completes.
func (g *RecoveryGroup) Start(ctx context.Context) error {
	if g == nil {
		return runtimeError(CodeWorkerConfig, "start", errors.New("nil recovery group"))
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.started {
		return runtimeError(CodeWorkerStarted, "start", errors.New("recovery group already started"))
	}
	byName := make(map[string]RecoveryWorker, len(g.workers))
	for _, w := range g.workers {
		if w.Name == "" || w.Probe == nil {
			return runtimeError(CodeWorkerConfig, "validate", errors.New("worker name and probe are required"))
		}
		if _, exists := byName[w.Name]; exists {
			return runtimeError(CodeWorkerConfig, "validate", errors.New("worker names must be unique"))
		}
		byName[w.Name] = w
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithCancel(ctx)
	g.cancel = cancel
	g.ctx = runCtx
	g.done = make(chan struct{})
	g.flights = make(map[string]*probeFlight)
	g.byName = byName
	g.started = true
	g.workerWG.Add(len(g.workers))
	for _, w := range g.workers {
		go g.run(runCtx, w)
	}
	go func() {
		g.workerWG.Wait()
		g.mu.Lock()
		if g.done != nil {
			close(g.done)
		}
		g.mu.Unlock()
	}()
	return nil
}

func (g *RecoveryGroup) run(ctx context.Context, w RecoveryWorker) {
	defer g.workerWG.Done()
	interval := w.Interval
	if interval <= 0 {
		interval = time.Second
	}
	maxBackoff := w.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = time.Minute
	}
	if maxBackoff < interval {
		maxBackoff = interval
	}
	backoff := interval
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if w.Eligible != nil && !w.Eligible() {
			backoff = interval
			timer.Reset(interval)
			continue
		}
		err := g.probe(ctx, w)
		if err == nil {
			backoff = interval
		} else {
			if w.OnFailure != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				w.OnFailure(err)
			}
			backoff = nextBackoff(backoff, maxBackoff)
		}
		timer.Reset(backoff)
	}
}

func nextBackoff(current, max time.Duration) time.Duration {
	if current <= 0 {
		current = time.Millisecond
	}
	if max <= 0 {
		max = time.Minute
	}
	next := current * 2
	if next < current || next > max {
		next = max
	}
	// Full jitter is bounded and never extends the configured maximum.
	jitterCap := next / 4
	if jitterCap > 0 {
		next += time.Duration(rand.Int64N(int64(jitterCap + 1)))
		if next > max {
			next = max
		}
	}
	return next
}
func linkedContext(parent, child context.Context) (context.Context, func()) {
	if parent == nil {
		parent = context.Background()
	}
	if child == nil {
		child = context.Background()
	}
	linked, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(child, cancel)
	return linked, func() {
		stop()
		cancel()
	}
}

// ProbeNow requests an immediate probe. Calls for the same worker coalesce to
// one in-flight probe and all callers observe the same result.
func (g *RecoveryGroup) ProbeNow(ctx context.Context, name string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	g.mu.Lock()
	if !g.started || g.cancel == nil {
		g.mu.Unlock()
		return ErrWorkerClosed
	}
	worker, ok := g.byName[name]
	if !ok {
		g.mu.Unlock()
		return runtimeError(CodeWorkerUnknown, "probe", errors.New("unknown worker"))
	}
	if existing := g.flights[name]; existing != nil {
		g.mu.Unlock()
		select {
		case <-existing.done:
			return existing.err
		case <-ctx.Done():
			return runtimeError(CodeWorkerCanceled, "probe", ctx.Err())
		}
	}
	flight := &probeFlight{done: make(chan struct{})}
	g.flights[name] = flight
	g.mu.Unlock()

	probeCtx, stop := linkedContext(g.ctx, ctx)
	err := g.executeProbe(probeCtx, worker)
	stop()
	g.mu.Lock()
	flight.err = err
	delete(g.flights, name)
	close(flight.done)
	g.mu.Unlock()
	return err
}

func (g *RecoveryGroup) probe(ctx context.Context, w RecoveryWorker) error {
	g.mu.Lock()
	if existing := g.flights[w.Name]; existing != nil {
		g.mu.Unlock()
		select {
		case <-existing.done:
			return existing.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	flight := &probeFlight{done: make(chan struct{})}
	g.flights[w.Name] = flight
	g.mu.Unlock()

	err := g.executeProbe(ctx, w)
	g.mu.Lock()
	flight.err = err
	delete(g.flights, w.Name)
	close(flight.done)
	g.mu.Unlock()
	return err
}

func (g *RecoveryGroup) executeProbe(ctx context.Context, w RecoveryWorker) error {
	if w.Eligible != nil && !w.Eligible() {
		return nil
	}
	timeout := w.ProbeTimeout
	if timeout <= 0 {
		timeout = w.Interval
		if timeout <= 0 {
			timeout = time.Second
		}
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := w.Probe(probeCtx)
	if err == nil {
		if w.Invalidate != nil {
			if invalidateErr := w.Invalidate(probeCtx); invalidateErr != nil {
				return runtimeError(CodeDependencyProbe, "invalidate "+w.Name, invalidateErr)
			}
		}
		if w.OnSuccess != nil {
			w.OnSuccess()
		}
		return nil
	}
	if probeCtx.Err() != nil {
		return runtimeError(CodeWorkerCanceled, "probe "+w.Name, probeCtx.Err())
	}
	return runtimeError(CodeDependencyProbe, "probe "+w.Name, err)
}

// Restart cancels and waits for the current workers before starting them again.
func (g *RecoveryGroup) Restart(ctx context.Context) error {
	if err := g.Close(ctx); err != nil {
		return err
	}
	return g.Start(ctx)
}

func (g *RecoveryGroup) Close(ctx context.Context) error {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	if !g.started {
		g.mu.Unlock()
		return nil
	}
	cancel, done := g.cancel, g.done
	g.mu.Unlock()
	cancel()
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-done:
		g.mu.Lock()
		g.started = false
		g.cancel = nil
		g.ctx = nil
		g.done = nil
		g.flights = nil
		g.mu.Unlock()
		return nil
	case <-ctx.Done():
		return runtimeError(CodeShutdownDeadline, "workers", ctx.Err())
	}
}
