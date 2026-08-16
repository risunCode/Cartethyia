package runtime

import (
	"errors"
	"strings"
	"testing"
)

func TestErrorErrorNilAndBranches(t *testing.T) {
	var nilErr *Error
	if got := nilErr.Error(); got != "<nil runtime error>" {
		t.Fatalf("nil Error.Error = %q", got)
	}

	codeOnly := &Error{Code: CodeServer}
	if got := codeOnly.Error(); got != string(CodeServer) {
		t.Fatalf("code-only Error.Error = %q", got)
	}

	noOp := &Error{Code: CodeServer, Err: errors.New("boom")}
	if got := noOp.Error(); got != "runtime.server: boom" {
		t.Fatalf("no-op Error.Error = %q", got)
	}

	full := &Error{Code: CodeServer, Op: "listen", Err: errors.New("boom")}
	if got := full.Error(); got != "runtime.server: listen: boom" {
		t.Fatalf("full Error.Error = %q", got)
	}
}

func TestErrorUnwrapNilAndNonNil(t *testing.T) {
	var nilErr *Error
	if nilErr.Unwrap() != nil {
		t.Fatal("nil Error.Unwrap should be nil")
	}

	cause := errors.New("root")
	err := &Error{Code: CodeDependencyProbe, Op: "close cache", Err: cause}
	if !errors.Is(err, cause) {
		t.Fatal("Unwrap should preserve errors.Is")
	}
	if err.Unwrap() != cause {
		t.Fatalf("Unwrap = %v", err.Unwrap())
	}
}

func TestErrorCodeStringNilAndNonNil(t *testing.T) {
	var nilErr *Error
	if nilErr.CodeString() != "" {
		t.Fatalf("nil CodeString = %q", nilErr.CodeString())
	}

	err := &Error{Code: CodeAlreadyStarted}
	if err.CodeString() != string(CodeAlreadyStarted) {
		t.Fatalf("CodeString = %q", err.CodeString())
	}
}

func TestCodeOfNilAndBranches(t *testing.T) {
	if CodeOf(nil) != "" {
		t.Fatalf("CodeOf(nil) = %q", CodeOf(nil))
	}
	if CodeOf(errors.New("plain")) != "" {
		t.Fatalf("CodeOf(plain) = %q", CodeOf(errors.New("plain")))
	}

	err := &Error{Code: CodeStartupCanceled, Op: "warmup", Err: errors.New("context canceled")}
	if CodeOf(err) != CodeStartupCanceled {
		t.Fatalf("CodeOf(coded) = %q", CodeOf(err))
	}
	wrapped := errors.Join(errors.New("outer"), err)
	if CodeOf(wrapped) != CodeStartupCanceled {
		t.Fatalf("CodeOf(joined) = %q", CodeOf(wrapped))
	}
}

func TestRuntimeErrorNilAndExistingBranches(t *testing.T) {
	nilCause := runtimeError(CodeWorkerClosed, "close", nil)
	var coded *Error
	if !errors.As(nilCause, &coded) || coded == nil {
		t.Fatalf("nil-cause runtimeError = %v", nilCause)
	}
	if coded.Code != CodeWorkerClosed || coded.Op != "close" || coded.Err != nil {
		t.Fatalf("nil-cause payload %#v", coded)
	}
	if !strings.Contains(nilCause.Error(), string(CodeWorkerClosed)) {
		t.Fatalf("nil-cause Error() = %q", nilCause.Error())
	}

	existing := &Error{Code: CodeDependencyRequired, Op: "bootstrap", Err: errors.New("pg down")}
	passthrough := runtimeError(CodeServer, "listen", existing)
	if passthrough != existing {
		t.Fatalf("existing *Error should pass through, got %#v", passthrough)
	}

	plain := runtimeError(CodeDependencyOptional, "redis", errors.New("offline"))
	if CodeOf(plain) != CodeDependencyOptional {
		t.Fatalf("plain wrap code=%q", CodeOf(plain))
	}
	if !strings.Contains(plain.Error(), "offline") {
		t.Fatalf("plain wrap err=%v", plain)
	}
	var wrapped *Error
	if !errors.As(plain, &wrapped) || wrapped.Op != "redis" || wrapped.Err == nil {
		t.Fatalf("plain wrap payload %#v", wrapped)
	}
}
