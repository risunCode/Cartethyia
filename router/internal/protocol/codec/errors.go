package codec

import (
	"errors"
	"fmt"
)

// TransformErrorCode is the stable machine-readable classification for a
// transform failure. Codes are package-prefixed so callers can safely expose
// them without parsing human error strings.
type TransformErrorCode string

const (
	CodeInvalidRequest           TransformErrorCode = "transforms.invalid_request"
	CodeUnsupportedFeature       TransformErrorCode = "transforms.unsupported_feature"
	CodeLossyPolicy              TransformErrorCode = "transforms.lossy_policy"
	CodePipelineOrder            TransformErrorCode = "transforms.pipeline_order"
	CodeMarkerLast               TransformErrorCode = "transforms.marker_last"
	CodeInvalidStage             TransformErrorCode = "transforms.invalid_stage"
	CodeInvalidDiagnostic        TransformErrorCode = "transforms.invalid_diagnostic"
	CodeStageFailure             TransformErrorCode = "transforms.stage_failure"
	CodeContextCanceled          TransformErrorCode = "transforms.context_canceled"
	CodeNativeSidecar            TransformErrorCode = "transforms.native_sidecar"
	CodeNativeSidecarLimit       TransformErrorCode = "transforms.native_sidecar_limit"
	CodeNativeSidecarPath        TransformErrorCode = "transforms.native_sidecar_path"
	CodeNativeSidecarDuplicate   TransformErrorCode = "transforms.native_sidecar_duplicate"
	CodeNativeSidecarUnconsumed  TransformErrorCode = "transforms.native_sidecar_unconsumed"
	CodeInvalidCanonical         TransformErrorCode = "transforms.invalid_canonical"
	CodeInvalidMediaReference    TransformErrorCode = "transforms.invalid_media_reference"
	CodeInvalidCompaction        TransformErrorCode = "transforms.invalid_compaction"
	CodeInvalidToolLedger        TransformErrorCode = "transforms.invalid_tool_ledger"
	CodeInvalidContextManagement TransformErrorCode = "transforms.invalid_context_management"
)

// Sentinel errors support errors.Is without requiring callers to compare
// concrete error values. TransformError.Is compares the stable code.
var (
	ErrInvalidRequest           = &TransformError{Code: CodeInvalidRequest}
	ErrUnsupportedFeature       = &TransformError{Code: CodeUnsupportedFeature}
	ErrLossyPolicy              = &TransformError{Code: CodeLossyPolicy}
	ErrPipelineOrder            = &TransformError{Code: CodePipelineOrder}
	ErrMarkerLast               = &TransformError{Code: CodeMarkerLast}
	ErrInvalidStage             = &TransformError{Code: CodeInvalidStage}
	ErrInvalidDiagnostic        = &TransformError{Code: CodeInvalidDiagnostic}
	ErrStageFailure             = &TransformError{Code: CodeStageFailure}
	ErrContextCanceled          = &TransformError{Code: CodeContextCanceled}
	ErrNativeSidecar            = &TransformError{Code: CodeNativeSidecar}
	ErrNativeSidecarLimit       = &TransformError{Code: CodeNativeSidecarLimit}
	ErrNativeSidecarPath        = &TransformError{Code: CodeNativeSidecarPath}
	ErrNativeSidecarDuplicate   = &TransformError{Code: CodeNativeSidecarDuplicate}
	ErrNativeSidecarUnconsumed  = &TransformError{Code: CodeNativeSidecarUnconsumed}
	ErrInvalidCanonical         = &TransformError{Code: CodeInvalidCanonical}
	ErrInvalidMediaReference    = &TransformError{Code: CodeInvalidMediaReference}
	ErrInvalidCompaction        = &TransformError{Code: CodeInvalidCompaction}
	ErrInvalidToolLedger        = &TransformError{Code: CodeInvalidToolLedger}
	ErrInvalidContextManagement = &TransformError{Code: CodeInvalidContextManagement}
)

// TransformError classifies a single failure surfaced by the codec package.
// Field identifies the offending wire path (e.g. "messages[2].role").
type TransformError struct {
	Code    TransformErrorCode
	Op      string // "decode-request", "encode-request", "decode-response", "encode-response", "pipeline"
	Surface string // wire surface identifier; matches contracts.Protocol
	Field   string
	Reason  string
	Wrapped error
}

// Error implements the error interface. The code is always emitted first so
// logs and metrics can classify errors without parsing provider text.
func (e *TransformError) Error() string {
	if e == nil {
		return "<nil>"
	}
	code := string(e.Code)
	if code == "" {
		code = "transforms.error"
	}
	location := ""
	if e.Op != "" {
		location = e.Op
	}
	if e.Surface != "" {
		location += " " + e.Surface
	}
	if e.Field != "" {
		location += " " + e.Field
	}
	if location != "" {
		location += ": "
	}
	message := location + e.Reason
	if message == "" {
		message = code
	} else {
		message = code + ": " + message
	}
	if e.Wrapped != nil {
		return fmt.Sprintf("%s: %v", message, e.Wrapped)
	}
	return message
}

// Unwrap exposes the underlying cause.
func (e *TransformError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Wrapped
}

// Is compares stable package-owned codes, allowing errors.Is(err,
// ErrUnsupportedFeature) while retaining the original operation and field.
func (e *TransformError) Is(target error) bool {
	other, ok := target.(*TransformError)
	return ok && e != nil && other != nil && e.Code != "" && e.Code == other.Code
}

// CodeString returns the stable code without exposing mutable error fields.
func (e *TransformError) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

func newTransformError(code TransformErrorCode, op, surface, field, reason string, wrapped error) *TransformError {
	return &TransformError{Code: code, Op: op, Surface: surface, Field: field, Reason: reason, Wrapped: wrapped}
}

func pipelineError(code TransformErrorCode, surface, field, reason string, wrapped error) *TransformError {
	return newTransformError(code, "pipeline", surface, field, reason, wrapped)
}

func wrapPipelineError(surface, field string, err error) *TransformError {
	if err == nil {
		return nil
	}
	var transformErr *TransformError
	if errors.As(err, &transformErr) {
		return transformErr
	}
	return pipelineError(CodeStageFailure, surface, field, "stage failed", err)
}

// FieldDisposition records the per-field outcome of an encoder pass.
// Encoders fill the slice as they traverse the canonical request, so
// downstream observers can audit which fields were preserved, adapted,
// or routed through the passthrough bucket.
type FieldDisposition struct {
	Path       string
	Action     FieldDispositionAction
	Reason     string
	TargetPath string
}

// FieldDispositionAction classifies how a field was handled.
type FieldDispositionAction string

const (
	// DispositionPreserved means the field was emitted verbatim.
	DispositionPreserved FieldDispositionAction = "preserved"
	// DispositionAdapted means the field was translated to the target
	// surface's native shape.
	DispositionAdapted FieldDispositionAction = "adapted"
	// DispositionUnsupported means the field cannot be expressed on the
	// target surface and was omitted. The Reason explains the gap.
	DispositionUnsupported FieldDispositionAction = "unsupported"
	// DispositionPassthrough means the field was carried as a raw
	// extension because the target surface has an unknown native slot.
	DispositionPassthrough FieldDispositionAction = "passthrough"
)

// EncoderResult is the per-encoder return value. Wire is the JSON-ready
// payload; Dispositions describe how each known field was handled.
type EncoderResult struct {
	Wire         map[string]any
	Dispositions []FieldDisposition
}
