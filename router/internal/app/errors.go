package app

import (
	"errors"
	"fmt"
)

// ErrorCode is the stable machine-readable classification for runtime failures.
// Diagnostics are intentionally separate and bounded at the lifecycle boundary.
type ErrorCode string

const (
	CodeInvalidTransition  ErrorCode = "runtime.invalid_transition"
	CodeWorkerConfig       ErrorCode = "runtime.worker_config"
	CodeWorkerStarted      ErrorCode = "runtime.worker_started"
	CodeWorkerUnknown      ErrorCode = "runtime.worker_unknown"
	CodeWorkerCanceled     ErrorCode = "runtime.worker_canceled"
	CodeWorkerClosed       ErrorCode = "runtime.worker_closed"
	CodeDependencyProbe    ErrorCode = "runtime.dependency_probe"
	CodeDependencyRequired ErrorCode = "runtime.dependency_required"
	CodeDependencyOptional ErrorCode = "runtime.dependency_optional"
	CodeStartupCanceled    ErrorCode = "runtime.startup_canceled"
	CodeAlreadyStarted     ErrorCode = "runtime.already_started"
	CodeShutdownDeadline   ErrorCode = "runtime.shutdown_deadline"
	CodeServer             ErrorCode = "runtime.server"
)

// Error carries a stable code while preserving errors.Is/As for the cause.
type Error struct {
	Code ErrorCode
	Op   string
	Err  error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil runtime error>"
	}
	if e.Err == nil {
		return string(e.Code)
	}
	if e.Op == "" {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Op, e.Err)
}
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}
func (e *Error) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

func runtimeError(code ErrorCode, op string, cause error) error {
	if cause == nil {
		return &Error{Code: code, Op: op}
	}
	var existing *Error
	if errors.As(cause, &existing) && existing != nil {
		return cause
	}
	return &Error{Code: code, Op: op, Err: cause}
}

// CodeOf returns a stable runtime code, if err belongs to this package.
func CodeOf(err error) ErrorCode {
	if err == nil {
		return ""
	}
	var coded *Error
	if errors.As(err, &coded) && coded != nil {
		return coded.Code
	}
	return ""
}
