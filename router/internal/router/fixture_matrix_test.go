package router

import (
	"io"
	"net/http"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestProxyFixtureFailureMatrixClassifiesStableKinds(t *testing.T) {
	t.Parallel()
	fixtures := []struct {
		name string
		in   ClassifyInput
		want FailureKind
	}{
		{name: "authentication", in: ClassifyInput{StatusCode: http.StatusUnauthorized, BodyPeek: `{"error":"invalid_api_key"}`}, want: FailureAuthentication},
		{name: "rate-limit", in: ClassifyInput{StatusCode: http.StatusTooManyRequests, HeaderValues: []string{"Retry-After: 5"}}, want: FailureRateLimit},
		{name: "quota", in: ClassifyInput{StatusCode: 0, BodyPeek: `{"error":"insufficient_quota"}`}, want: FailureQuota},
		{name: "context-overflow", in: ClassifyInput{StatusCode: 0, BodyPeek: `{"error":"context_length_exceeded"}`}, want: FailureFatal},
		{name: "malformed-body", in: ClassifyInput{StatusCode: http.StatusOK, BodyPeek: "not-json"}, want: FailureFatal},
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			failure := Classify(fixture.in)
			if failure == nil || failure.Kind != fixture.want {
				t.Fatalf("failure=%#v kind=%q, want %q", failure, failureKind(failure), fixture.want)
			}
			if failure.Policy == RetryPolicy("") {
				t.Fatal("classified failure has no retry policy")
			}
		})
	}
}

func failureKind(failure *Failure) FailureKind {
	if failure == nil {
		return ""
	}
	return failure.Kind
}

func TestProxyFixtureStreamTruncationAcrossSurfaces(t *testing.T) {
	t.Parallel()
	for _, surface := range contracts.AllSurfaces() {
		surface := surface
		t.Run(string(surface), func(t *testing.T) {
			t.Parallel()
			truncated := make(chan StreamEvent)
			close(truncated)
			bridge := NewStreamBridge(NewStream(truncated, nil, 0, 0), surface, "fixture-model")
			_, err := io.ReadAll(bridge)
			if StreamCodeOf(err) != StreamCodeUpstreamTruncated {
				t.Fatalf("surface=%q truncation code=%q error=%v, want %q", surface, StreamCodeOf(err), err, StreamCodeUpstreamTruncated)
			}
		})
	}
}
