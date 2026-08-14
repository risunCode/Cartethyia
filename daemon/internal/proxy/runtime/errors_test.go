package proxy

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func TestClassifyHonorsCancellationBeforeStatus(t *testing.T) {
	failure := Classify(ClassifyInput{
		StatusCode: http.StatusUnauthorized,
		Err:        context.Canceled,
	})
	if failure.Kind != FailureAborted {
		t.Fatalf("kind = %q, want %q", failure.Kind, FailureAborted)
	}
	if failure.Policy != RetryNever {
		t.Fatalf("policy = %q, want %q", failure.Policy, RetryNever)
	}
}

func TestClassifyDoesNotRetryInvalidRequest(t *testing.T) {
	failure := Classify(ClassifyInput{StatusCode: http.StatusBadRequest})
	if failure.Kind != FailureInvalidRequest {
		t.Fatalf("kind = %q, want %q", failure.Kind, FailureInvalidRequest)
	}
	if failure.Policy != RetryNever {
		t.Fatalf("policy = %q, want %q", failure.Policy, RetryNever)
	}
	if failure.Poison {
		t.Fatal("invalid client request must not poison the account")
	}
}

func TestClassifyStructuredSignalsBeforeUnknownTransport(t *testing.T) {
	failure := Classify(ClassifyInput{BodyPeek: `{"error":"usage_limit"}`})
	if failure.Kind != FailureQuota {
		t.Fatalf("kind = %q, want %q", failure.Kind, FailureQuota)
	}
	if failure.Policy != RetryNever {
		t.Fatalf("policy = %q, want %q", failure.Policy, RetryNever)
	}
}

func TestClassifyUnknownTransportIsFatalAndPoisoning(t *testing.T) {
	cause := errors.New("connection reset")
	failure := Classify(ClassifyInput{Err: cause})
	if failure.Kind != FailureUnknown {
		t.Fatalf("kind = %q, want %q", failure.Kind, FailureUnknown)
	}
	if !failure.Poison {
		t.Fatal("unknown transport failure must poison the account")
	}
	if !errors.Is(failure, cause) {
		t.Fatalf("failure does not unwrap original cause: %v", failure)
	}
}

func TestClassifyPreservesSpecificRateEvidence(t *testing.T) {
	failure := Classify(ClassifyInput{
		StatusCode:   429,
		HeaderValues: []string{"Retry-After: 12"},
	})
	if failure.CodeString() != "provider.rate_limit" {
		t.Fatalf("code=%q want provider.rate_limit", failure.CodeString())
	}
	if failure.RateSource != contracts.RateSourceProviderRate || failure.RateScope != contracts.RateScopeProvider {
		t.Fatalf("rate evidence=%+v", failure)
	}
	if !failure.Retryable || !failure.AlternateAccountEligible || failure.RetryAfterMS != 12000 {
		t.Fatalf("retry evidence=%+v", failure)
	}
}
