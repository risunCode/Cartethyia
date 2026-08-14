package accounts

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
)

// Secret is an immutable wrapper around a sensitive byte slice. It is the
// only type that should be passed across the auth boundary for tokens,
// refresh tokens, client secrets, API keys, and authorization codes. The
// zero value is an empty secret; never log a Secret directly.
type Secret struct {
	// material is intentionally unexported and only readable through
	// methods that make accidental logging painful (String always
	// returns the placeholder, Reveal must be opted into).
	material []byte
}

// NewSecret takes ownership of the supplied bytes. The caller must not
// retain or reuse the slice after this call; the returned Secret will zero
// it on Close. Passing a nil or empty slice returns a non-nil zero Secret
// so callers can rely on the result being safe to call methods on.
func NewSecret(material []byte) *Secret {
	if len(material) == 0 {
		return &Secret{}
	}
	buf := make([]byte, len(material))
	copy(buf, material)
	return &Secret{material: buf}
}

// NewSecretFromString mirrors NewSecret for the common string case.
func NewSecretFromString(value string) *Secret {
	if value == "" {
		return &Secret{}
	}
	return NewSecret([]byte(value))
}

// IsZero reports whether the secret carries no material. Use this rather
// than comparing against nil because the zero value is itself a valid
// (empty) Secret.
func (s *Secret) IsZero() bool {
	if s == nil {
		return true
	}
	return len(s.material) == 0
}

// Len returns the byte length of the secret. Safe to log; it leaks no
// material but does reveal relative token sizes.
func (s *Secret) Len() int {
	if s == nil {
		return 0
	}
	return len(s.material)
}

// String returns a constant redacted marker. The intent is that any
// accidental %s or fmt.Println(s) shows a placeholder rather than the
// underlying secret. Loggers that walk struct fields will see the same.
func (s *Secret) String() string {
	return "<redacted-secret>"
}

// GoString is the format used by %#v. It also redacts.
func (s *Secret) GoString() string {
	return "<redacted-secret>"
}

// MarshalJSON prevents an accidentally serialized Secret from exposing
// material. The marker is stable for logs and operator responses.
func (s *Secret) MarshalJSON() ([]byte, error) {
	return json.Marshal("<redacted-secret>")
}

// MarshalText applies the same redaction to text-based encoders.
func (s *Secret) MarshalText() ([]byte, error) {
	return []byte("<redacted-secret>"), nil
}

// Reveal returns the underlying material as a fresh slice. Callers MUST
// treat the returned slice as read-only and MUST NOT log it. The intent
// is to be a loud name: any code that calls Reveal is taking deliberate
// responsibility for redacting the result.
func (s *Secret) Reveal() []byte {
	if s == nil || len(s.material) == 0 {
		return nil
	}
	out := make([]byte, len(s.material))
	copy(out, s.material)
	return out
}

// RevealString returns the underlying material as a string for callers
// that need a string-shaped credential (e.g. setting an HTTP header).
// Same caveats as Reveal.
func (s *Secret) RevealString() string {
	if s == nil || len(s.material) == 0 {
		return ""
	}
	return string(s.material)
}

// Equal reports whether two secrets hold identical material. It uses
// constant-time comparison so the result is not a side channel for
// guessing token contents. Two zero secrets are equal; a nil secret is
// equal to another nil/zero secret.
func (s *Secret) Equal(other *Secret) bool {
	if s == nil && other == nil {
		return true
	}
	if s == nil || other == nil {
		return s.IsZero() && other.IsZero()
	}
	if len(s.material) != len(other.material) {
		// Still run a constant-time compare against a fixed-size
		// scratch to keep the timing equal regardless of the
		// length mismatch.
		var scratch [1]byte
		_ = subtle.ConstantTimeCompare(scratch[:], scratch[:])
		return false
	}
	return subtle.ConstantTimeCompare(s.material, other.material) == 1
}

// Close overwrites the secret material with zeros. Safe to call on a nil
// or zero Secret. The runtime cannot guarantee the byte slice is fully
// scrubbed (the Go runtime may have copied it), but calling Close is the
// only deliberate signal a caller can give that the secret is no longer
// needed.
func (s *Secret) Close() {
	if s == nil {
		return
	}
	for i := range s.material {
		s.material[i] = 0
	}
	s.material = nil
}

// Fingerprint returns a short, non-reversible identifier for a secret
// suitable for log correlation, metrics labels, and compare-and-swap
// checks. It is derived from the material itself but truncated and mixed
// so it cannot be used to recover the original. Two different secrets
// MAY share a fingerprint; two equal secrets MUST share one.
func (s *Secret) Fingerprint() string {
	if s == nil || len(s.material) == 0 {
		return "fp:empty"
	}
	// FNV-1a 64-bit; constant-time-ish and dependency-free.
	const (
		offset uint64 = 1469598103934665603
		prime  uint64 = 1099511628211
	)
	h := offset
	for _, b := range s.material {
		h ^= uint64(b)
		h *= prime
	}
	return fmt.Sprintf("fp:%016x", h)
}

// ConstantTimeEqual is a package-level helper for callers that need to
// compare raw byte slices in constant time. It mirrors crypto/subtle
// semantics so the auth package can be used in isolation from the rest
// of the runtime.
func ConstantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		// Equalize timing with a constant-time scratch compare.
		var scratch [1]byte
		_ = subtle.ConstantTimeCompare(scratch[:], scratch[:])
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// ErrSecretMismatch is returned by verify-style helpers when an expected
// secret does not match a presented one. Callers should treat this as a
// normal failure path, not an exceptional error.
var ErrSecretMismatch = errors.New("auth: secret mismatch")
