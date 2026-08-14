// Package accounts defines typed, provider-neutral credential lifecycle errors.
// Error messages and causes are sanitized so raw provider material cannot enter
// logs or public responses.
package accounts

import (
	"context"
	"errors"
	"strings"
)

// ErrorKind classifies credential-lifecycle failures so callers can decide
// between refresh-and-retry, prompt-the-user, and treat-as-fatal paths.
type ErrorKind string

const (
	// ErrKindInvalidRequest means the supplied credentials or input cannot
	// possibly succeed (malformed, missing required field, empty value).
	// Never recoverable through refresh; the caller must collect new material.
	ErrKindInvalidRequest ErrorKind = "invalid_request"

	// ErrKindReauthentication means the provider has rejected the
	// credential in a way that cannot be resolved by refresh: revoked,
	// deleted account, MFA required, password reset. The user must
	// re-authorize; retry will loop indefinitely.
	ErrKindReauthentication ErrorKind = "reauthentication_required"

	// ErrKindRefreshTransient means refresh failed but may succeed
	// shortly (5xx, network, rate limit on the auth endpoint). The
	// caller may back off and retry, but the existing token is still
	// potentially usable until it actually expires.
	ErrKindRefreshTransient ErrorKind = "refresh_transient"

	// ErrKindRefreshFatal means refresh will never succeed for this
	// credential in its current form (refresh token revoked, client
	// unregistered, scope removed). Distinct from reauthentication so
	// callers can fall back without prompting the user.
	ErrKindRefreshFatal ErrorKind = "refresh_fatal"

	// ErrKindStorage means a local store rejected the operation
	// (write conflict, missing account, version mismatch).
	ErrKindStorage ErrorKind = "storage"

	// ErrKindUnknown wraps any unclassified failure; treated as
	// transient by the default retry policy.
	ErrKindUnknown ErrorKind = "unknown"
)

// Error is the typed auth failure returned by every credential lifecycle
// operation. The Reason field is the only machine-readable classifier; the
// wrapped error and string form exist only for logging and errors.Is/As.
type Error struct {
	// ProviderID identifies the upstream that produced the failure.
	ProviderID string
	// AccountID identifies the local account record, when known.
	AccountID string
	// Reason classifies the failure for retry/UX decisions.
	Reason ErrorKind
	// Code is an optional stable provider-scoped code, for example
	// GROK_OAUTH_INVALID_GRANT. It is bounded metadata, never raw provider text.
	Code string
	// Cause is the underlying error; never a raw credential.
	Cause error
}

// Error returns a redacted string form. Provider and account ids are kept
// because they are not secrets; the underlying error is included as-is and
// must already be free of token material by the time it reaches this type.
func (e *Error) Error() string {
	if e == nil {
		return "<nil auth error>"
	}
	cause := ""
	if e.Cause != nil {
		cause = ": " + e.Cause.Error()
	}
	code := ""
	if e.Code != "" {
		code = " code=" + e.Code
	}
	switch {
	case e.ProviderID != "" && e.AccountID != "":
		return "auth: provider=" + e.ProviderID + " account=" + e.AccountID + " reason=" + string(e.Reason) + code + cause
	case e.ProviderID != "":
		return "auth: provider=" + e.ProviderID + " reason=" + string(e.Reason) + code + cause
	default:
		return "auth: reason=" + string(e.Reason) + code + cause
	}
}

// Unwrap exposes the underlying error for errors.Is/As.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Is reports whether the target is another *Error with the same Reason.
// Allows callers to write errors.Is(err, ErrReauthenticationRequired) style
// checks without comparing structs.
func (e *Error) Is(target error) bool {
	if e == nil || target == nil {
		return false
	}
	other, ok := target.(*Error)
	if !ok {
		return false
	}
	return e.Reason == other.Reason
}

// Sentinel errors for errors.Is comparisons. Always compare via errors.Is;
// constructing one with &Error{Reason: ErrKindX} is also valid.
var (
	// ErrInvalidRequest signals a malformed credential or input.
	ErrInvalidRequest = &Error{Reason: ErrKindInvalidRequest}
	// ErrReauthenticationRequired signals that the user must re-authorize.
	ErrReauthenticationRequired = &Error{Reason: ErrKindReauthentication}
	// ErrRefreshTransient signals a refresh attempt that may succeed later.
	ErrRefreshTransient = &Error{Reason: ErrKindRefreshTransient}
	// ErrRefreshFatal signals that refresh will never succeed as configured.
	ErrRefreshFatal = &Error{Reason: ErrKindRefreshFatal}
	// ErrStorage signals a local persistence failure.
	ErrStorage = &Error{Reason: ErrKindStorage}
)

// NewError wraps an arbitrary cause in a typed *Error. Causes are reduced to
// known safe sentinels so provider messages cannot carry token material into
// errors, logs, or public responses.
func NewError(kind ErrorKind, providerID, accountID string, cause error) *Error {
	return &Error{
		ProviderID: providerID,
		AccountID:  accountID,
		Reason:     kind,
		Cause:      sanitizeCause(cause),
	}
}

// NewProviderError adds a bounded stable provider code without exposing the
// provider response body. Codes are normalized to printable uppercase tokens.
func NewProviderError(kind ErrorKind, providerID, accountID, code string, cause error) *Error {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) > 64 {
		code = code[:64]
	}
	if strings.IndexFunc(code, func(r rune) bool {
		return (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-'
	}) >= 0 {
		code = ""
	}
	return &Error{ProviderID: providerID, AccountID: accountID, Reason: kind, Code: code, Cause: sanitizeCause(cause)}
}

func sanitizeCause(cause error) error {
	switch {
	case cause == nil:
		return nil
	case errors.Is(cause, context.Canceled):
		return context.Canceled
	case errors.Is(cause, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(cause, ErrSecretNotFound):
		return ErrSecretNotFound
	case errors.Is(cause, ErrRecordNotFound):
		return ErrRecordNotFound
	case errors.Is(cause, ErrAccountNotFound):
		return ErrAccountNotFound
	case errors.Is(cause, ErrVersionMismatch):
		return ErrVersionMismatch
	default:
		return errors.New("auth operation failed")
	}
}

// Classify is a small helper used by adapters that want a single decision
// point: returns true when the error kind means the caller should give up
// and require fresh user credentials.
func Classify(err error) ErrorKind {
	if err == nil {
		return ""
	}
	var ae *Error
	if errors.As(err, &ae) {
		return ae.Reason
	}
	return ErrKindUnknown
}

// RequiresReauth reports whether the caller must collect new credentials
// from the user rather than retrying. It is the canonical "should I prompt
// for login?" predicate.
func RequiresReauth(err error) bool {
	kind := Classify(err)
	return kind == ErrKindReauthentication || kind == ErrKindInvalidRequest
}
