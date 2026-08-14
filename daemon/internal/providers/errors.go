package providers

import (
	"errors"
	"fmt"
	"strings"
)

var ErrRegistryUnavailable = errors.New("providers: registry is unavailable")
var ErrInvalidRegistration = errors.New("providers: invalid provider registration")

// UnknownProviderError is returned by the registry when a requested provider
// id is not registered. The router uses it to surface a 404 to the client.
type UnknownProviderError struct {
	// ProviderID is the id the router asked the registry to resolve.
	ProviderID string
}

func (e *UnknownProviderError) Error() string {
	return fmt.Sprintf("providers: unknown provider %q", e.ProviderID)
}

// Is enables errors.Is(err, &UnknownProviderError{}).
func (e *UnknownProviderError) Is(target error) bool {
	var other *UnknownProviderError
	return errors.As(target, &other) && other.ProviderID == e.ProviderID
}

// UnknownModelError is returned by a Provider's ResolveTarget when the
// provider exists but does not declare the requested model id.
type UnknownModelError struct {
	ProviderID string
	ModelID    string
}

func (e *UnknownModelError) Error() string {
	return fmt.Sprintf("providers: provider %q does not declare model %q", e.ProviderID, e.ModelID)
}

// UnknownSurfaceError is returned when the provider exists but does not
// support the requested wire surface.
type UnknownSurfaceError struct {
	ProviderID string
	Surface    Surface
}

func (e *UnknownSurfaceError) Error() string {
	return fmt.Sprintf("providers: provider %q does not support surface %q", e.ProviderID, e.Surface)
}

// AuthError is returned by a Provider when a credential is missing or
// rejected before any network call is attempted.
type AuthError struct {
	ProviderID string
	Reason     string
}

func (e *AuthError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("providers: provider %q rejected the credential", e.ProviderID)
	}
	return fmt.Sprintf("providers: provider %q rejected the credential: %s", e.ProviderID, e.Reason)
}

// StreamingUnsupportedError is returned when the model supports a surface but
// the provider has not enabled streaming on that surface.
type StreamingUnsupportedError struct {
	ProviderID string
	Surface    Surface
}

func (e *StreamingUnsupportedError) Error() string {
	return fmt.Sprintf("providers: provider %q does not support streaming on surface %q", e.ProviderID, e.Surface)
}

// IDMismatchError is returned by ResolveTarget when the target passed to a
// adapter belongs to a different provider. This guards against a router
// accidentally handing a Cursor-shaped request to the Anthropic adapter.
type IDMismatchError struct {
	AdapterID string
	TargetID  string
}

func (e *IDMismatchError) Error() string {
	return fmt.Sprintf("providers: adapter %q cannot serve provider %q", e.AdapterID, e.TargetID)
}

// LoaderError is returned by the registry when a registered Loader fails
// during Get. Callers can use errors.Is/As to unwrap the underlying cause.
// The registry deliberately does NOT collapse this to UnknownProviderError:
// the provider is registered, the loader just could not materialize it, and
// the cause is useful for diagnostics.
type LoaderError struct {
	// ProviderID is the id the caller asked the registry to resolve.
	ProviderID string
	// Err is the underlying loader failure. It may be nil when the loader
	// returned a malformed provider (nil or empty metadata id).
	Err error
}

func (e *LoaderError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("providers: loader for %q produced an invalid provider", e.ProviderID)
	}
	return fmt.Sprintf("providers: loader for %q failed: %v", e.ProviderID, e.Err)
}

func (e *LoaderError) Unwrap() error { return e.Err }

// lookupErrorPrefix keeps error message formatting consistent across adapters.
func lookupErrorPrefix(providerID string) string {
	return strings.TrimSpace(providerID)
}
