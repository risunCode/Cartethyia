package load

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunExecutesBoundedConcurrentRequests(t *testing.T) {
	var calls atomic.Int32
	report, err := Run(context.Background(), Config{Workers: 4, Requests: 20, Timeout: time.Second}, func(context.Context) error { calls.Add(1); return nil })
	if err != nil || report.Success != 20 || report.Failures != 0 || calls.Load() != 20 {
		t.Fatalf("report=%#v calls=%d err=%v", report, calls.Load(), err)
	}
	if report.Latency.Count != 20 || report.Throughput <= 0 || report.Offered != 20 {
		t.Fatalf("missing measurable report=%#v", report)
	}
}

func TestRunReportsCallFailures(t *testing.T) {
	report, err := Run(context.Background(), Config{Workers: 2, Requests: 4, Timeout: time.Second}, func(context.Context) error { return errors.New("fixture") })
	if err != nil || report.Failures != 4 || report.Errors[CodeCall] != 4 {
		t.Fatalf("report=%#v err=%v", report, err)
	}
}

func TestRunScenarioReportsKindsStreamsRetriesAndResources(t *testing.T) {
	var active atomic.Int32
	report, err := RunScenario(context.Background(), Config{
		Workers: 4, Requests: 100, Timeout: time.Second, MaxInFlight: 2,
		Resources: func() ResourceSnapshot {
			value := active.Load() + 1
			return ResourceSnapshot{
				RSSBytes: uint64(value) * 10, HeapBytes: uint64(value) * 20,
				Goroutines: int(value), FileDescriptors: int(value),
				Connections: int(value), ActiveStreams: int(value),
			}
		},
	}, Scenario{Call: func(_ context.Context, index int) CallResult {
		active.Add(1)
		defer active.Add(-1)
		switch {
		case index%10 == 0:
			return CallResult{Kind: KindRejected, Err: &Error{Code: CodeRejected}}
		case index%10 == 1:
			return CallResult{Kind: KindCanceled, Err: context.Canceled}
		case index%10 == 2:
			return CallResult{Kind: KindFailure, Err: &Error{Code: "provider.failure"}, RetryCount: 2}
		default:
			return CallResult{Kind: KindSuccess, Streamed: index%3 == 0, StreamDuration: 2 * time.Millisecond}
		}
	}})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Total != 100 || report.Completed != 100 || report.Success == 0 || report.Rejected == 0 || report.Canceled == 0 || report.Failures == 0 {
		t.Fatalf("unexpected outcome report=%#v", report)
	}
	if report.Streams.Count == 0 || report.Streams.Duration.P50 != 2*time.Millisecond || report.Retries != 20 || report.Errors[CodeRejected] == 0 {
		t.Fatalf("missing stream/error/retry report=%#v", report)
	}
	if report.PeakConnections == 0 || report.PeakHeapBytes == 0 {
		t.Fatalf("missing resource report=%#v", report)
	}
}

func TestRunScenarioRejectsUnsafeBoundsWithStableCode(t *testing.T) {
	_, err := RunScenario(context.Background(), Config{Workers: 2, Requests: 2, MaxInFlight: DefaultMaxInFlight + 1}, Scenario{
		Call: func(context.Context, int) CallResult { return CallResult{} },
	})
	var loadErr *Error
	if !errors.As(err, &loadErr) || loadErr.Code != CodeLimit {
		t.Fatalf("err=%v, want %s", err, CodeLimit)
	}
}

func TestRunScenarioTimeoutIsBounded(t *testing.T) {
	start := time.Now()
	report, err := RunScenario(context.Background(), Config{Workers: 2, Requests: 1_000, Timeout: 10 * time.Millisecond}, Scenario{Call: func(ctx context.Context, _ int) CallResult {
		<-ctx.Done()
		return CallResult{Kind: KindCanceled, Err: ctx.Err()}
	}})
	if err == nil || CodeOf(err) != CodeTimeout || report.Total == 0 || time.Since(start) > time.Second {
		t.Fatalf("report=%#v err=%v elapsed=%s", report, err, time.Since(start))
	}
}

func TestRunScenarioThousandsRequestsRemainBounded(t *testing.T) {
	if testing.Short() {
		t.Skip("thousands-request profile is opt-in under -short")
	}
	var active atomic.Int32
	report, err := RunScenario(context.Background(), Config{
		Workers: 16, Requests: 2_000, Timeout: 2 * time.Second, MaxInFlight: 16,
		Resources: func() ResourceSnapshot {
			return ResourceSnapshot{HeapBytes: uint64(active.Load() + 1), Connections: int(active.Load()) + 1}
		},
	}, Scenario{Call: func(context.Context, int) CallResult {
		active.Add(1)
		active.Add(-1)
		return CallResult{Kind: KindSuccess}
	}})
	if err != nil || report.Total != 2_000 || report.Success != 2_000 {
		t.Fatalf("report=%#v err=%v", report, err)
	}
	if report.PeakConnections > 16 || report.PeakHeapBytes == 0 {
		t.Fatalf("resource bound exceeded report=%#v", report)
	}
}
