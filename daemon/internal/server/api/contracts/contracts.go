// Package apicontracts defines the narrow proxy and catalog contracts used by
// the Cartethyia /v1 API surface. It stays outside an internal subpackage so
// proxy and runtime packages can satisfy the interfaces without import cycles.
package apicontracts

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	domaincontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Request metadata is intentionally bounded and contains only operator-safe
// identifiers. It is shared by V2 handlers and observability adapters so
// correlation and display rules do not drift between transports.
const (
	MaxRequestIDBytes    = 96
	MaxTraceIDBytes      = 96
	MaxOriginBytes       = 32
	MaxClientFamilyBytes = 32
	MaxDisplayBytes      = 128
	MaxProxySourceBytes  = 16
)

// RequestMetadata is the safe metadata attached to a request evidence row.
// It has no body, prompt, header, credential, or provider-response fields.
type RequestMetadata struct {
	RequestID      string `json:"request_id,omitempty"`
	TraceID        string `json:"trace_id,omitempty"`
	Origin         string `json:"origin,omitempty"`
	ClientFamily   string `json:"client_family,omitempty"`
	AccountID      string `json:"account_id,omitempty"`
	AccountEmail   string `json:"account_email,omitempty"`
	AccountName    string `json:"account_name,omitempty"`
	AccountDisplay string `json:"account_display,omitempty"`
	ProxyID        string `json:"proxy_id,omitempty"`
	ProxyName      string `json:"proxy_name,omitempty"`
	ProxyDisplay   string `json:"proxy_display,omitempty"`
	ProxySource    string `json:"proxy_source,omitempty"`
}

// Validate checks all metadata bounds and rejects control characters or
// credential-shaped values before metadata can enter a response or event.
func (m RequestMetadata) Validate() error {
	for _, field := range []struct {
		name  string
		value string
		max   int
	}{
		{"request_id", m.RequestID, MaxRequestIDBytes},
		{"trace_id", m.TraceID, MaxTraceIDBytes},
		{"origin", m.Origin, MaxOriginBytes},
		{"client_family", m.ClientFamily, MaxClientFamilyBytes},
		{"account_id", m.AccountID, MaxDisplayBytes},
		{"account_email", m.AccountEmail, MaxDisplayBytes},
		{"account_name", m.AccountName, MaxDisplayBytes},
		{"account_display", m.AccountDisplay, MaxDisplayBytes},
		{"proxy_id", m.ProxyID, MaxDisplayBytes},
		{"proxy_name", m.ProxyName, MaxDisplayBytes},
		{"proxy_display", m.ProxyDisplay, MaxDisplayBytes},
		{"proxy_source", m.ProxySource, MaxProxySourceBytes},
	} {
		if err := ValidateMetadataValue(field.name, field.value, field.max); err != nil {
			return err
		}
	}
	if m.ProxySource != "" {
		switch m.ProxySource {
		case "configured", "direct", "none", "unknown":
		default:
			return fmt.Errorf("invalid proxy_source")
		}
	}
	return nil
}

// ValidateMetadataValue validates one optional bounded metadata value.
func ValidateMetadataValue(name, value string, max int) error {
	if len(value) > max {
		return fmt.Errorf("%s exceeds %d bytes", name, max)
	}
	if strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return fmt.Errorf("%s contains control characters", name)
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"authorization", "api_key", "apikey", "access_token", "refresh_token", "client_secret", "password=", "secret=", "bearer "} {
		if strings.Contains(lower, marker) {
			return fmt.Errorf("%s contains sensitive material", name)
		}
	}
	return nil
}

// ValidateRequestID applies the stricter syntax used for inbound correlation
// headers. IDs are opaque but must be printable ASCII and cannot contain
// whitespace or separators that permit header/log injection.
func ValidateRequestID(name, value string) error {
	if value == "" {
		return fmt.Errorf("%s is required", name)
	}
	if len(value) > MaxRequestIDBytes {
		return fmt.Errorf("%s exceeds %d bytes", name, MaxRequestIDBytes)
	}
	for i, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == ':' {
			continue
		}
		return fmt.Errorf("%s contains invalid character at %d", name, i)
	}
	return nil
}

// AccountDisplay resolves account identity in the contract's deterministic
// precedence order: provider email, configured name/label, then local ID.
func AccountDisplay(email, name, id string) string {
	for _, value := range []string{email, name, id} {
		if value != "" && ValidateMetadataValue("account_display", value, MaxDisplayBytes) == nil {
			return value
		}
	}
	return ""
}

// ProxyDisplay resolves configured proxy name/label before the bounded ID.
func ProxyDisplay(name, id string) string {
	for _, value := range []string{name, id} {
		if value != "" && ValidateMetadataValue("proxy_display", value, MaxDisplayBytes) == nil {
			return value
		}
	}
	return ""
}

// MaxBodyBytes bounds JSON parsing across every /v1 handler.
const MaxBodyBytes = 10 * 1024 * 1024

// Stream is the streaming response contract returned by ProxyService.
type Stream interface {
	StatusCode() int
	ContentType() string
	Body() StreamReader
	Headers() http.Header
}

// StreamReader is the minimal read/close surface needed to drain an upstream body.
type StreamReader interface {
	Read(p []byte) (int, error)
	Close() error
}

// ProxyService is the narrow interface consumed by /v1 handlers.
type ProxyService interface {
	Dispatch(req *domaincontracts.Request) (Stream, error)
}

// ContextProxyService is implemented by dispatchers that preserve the
// inbound request context through normalization, routing, and transport.
type ContextProxyService interface {
	DispatchContext(context.Context, *domaincontracts.Request) (Stream, error)
}

// DispatchContext calls the cancellable dispatch API when the proxy provides
// it, while retaining compatibility with lightweight legacy test doubles.
func DispatchContext(ctx context.Context, proxy ProxyService, req *domaincontracts.Request) (Stream, error) {
	if contextual, ok := proxy.(ContextProxyService); ok {
		return contextual.DispatchContext(ctx, req)
	}
	return proxy.Dispatch(req)
}

// ModelCatalog is the model listing contract used by /v1/models.
type ModelCatalog interface {
	List() ([]domaincontracts.Account, error)
}
