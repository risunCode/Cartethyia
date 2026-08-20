// Package protocol owns bounded, non-authoritative client dialect evidence.
// Profiles describe the source contract a client is likely to consume; they do
// not participate in authentication, tenant identity, routing, or permissions.
package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
)

const (
	MaxEvidence       = 8
	MaxAmbiguities    = 8
	MaxReasonBytes    = 96
	MaxHeaderBytes    = 256
	MaxBodyScanBytes  = 64 * 1024
	MaxEndpointBytes  = 512
	MaxProfileReasons = MaxEvidence + MaxAmbiguities
)

type ClientProfileID string

const (
	ProfileUnknownStandard  ClientProfileID = "unknown-standard"
	ProfileClaudeCode       ClientProfileID = "claude-code"
	ProfileCodexCLI         ClientProfileID = "codex-cli"
	ProfileGeminiCLI        ClientProfileID = "gemini-cli"
	ProfileOpenAICompatible ClientProfileID = "openai-compatible-cli"
)

// ErrorCode is stable and safe to expose to diagnostics and metrics.
type ErrorCode string

const (
	CodeInvalidInput    ErrorCode = "compat_invalid_input"
	CodeInvalidSurface  ErrorCode = "compat_invalid_surface"
	CodeInvalidProfile  ErrorCode = "compat_invalid_profile"
	CodeInvalidEvidence ErrorCode = "compat_invalid_evidence"
	CodeEvidenceBounds  ErrorCode = "compat_evidence_bounds"
	CodeBodyTooLarge    ErrorCode = "compat_body_too_large"
	CodeContextInvalid  ErrorCode = "compat_context_invalid"
)

// Error is a bounded typed classifier failure. Cause is retained for errors.Is
// and errors.As, but is intentionally omitted from Error to avoid wire leakage.
type Error struct {
	Code  ErrorCode
	Field string
	Cause error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil compatibility error>"
	}
	code := string(e.Code)
	if code == "" {
		code = "compat_error"
	}
	if e.Field == "" {
		return code
	}
	return code + ": field=" + e.Field
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && e != nil && other != nil && e.Code != "" && e.Code == other.Code
}

func (e *Error) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

func CodeOf(err error) ErrorCode {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		return typed.Code
	}
	var planErr *PlanError
	if errors.As(err, &planErr) && planErr != nil {
		return planErr.Code
	}
	var capabilityErr *CapabilityError
	if errors.As(err, &capabilityErr) && capabilityErr != nil {
		return capabilityErr.Code
	}
	return ""
}

// EvidenceCode identifies a bounded, secret-free classification fact.
type EvidenceCode string

const (
	EvidenceEndpointSurface EvidenceCode = "evidence.endpoint_surface"
	EvidenceBodySurface     EvidenceCode = "evidence.body_surface"
	EvidenceHeaderUserAgent EvidenceCode = "evidence.header.user_agent"
	EvidenceHeaderXApp      EvidenceCode = "evidence.header.x_app"
	EvidenceHeaderIntent    EvidenceCode = "evidence.header.openai_intent"
	EvidenceNativeGemini    EvidenceCode = "evidence.native_gemini_shape"
	EvidenceStandardShape   EvidenceCode = "evidence.standard_shape"
)

// AmbiguityCode records a bounded conflict or absence of dialect evidence.
type AmbiguityCode string

const (
	AmbiguityUnknownClient      AmbiguityCode = "ambiguity.unknown_client"
	AmbiguityEndpointBody       AmbiguityCode = "ambiguity.endpoint_body_conflict"
	AmbiguityHeaderSurface      AmbiguityCode = "ambiguity.header_surface_conflict"
	AmbiguityWeakHint           AmbiguityCode = "ambiguity.weak_header_hint"
	AmbiguityBodyUnavailable    AmbiguityCode = "ambiguity.body_shape_unavailable"
	AmbiguityUnsupportedSurface AmbiguityCode = "ambiguity.unsupported_surface"
)

// Evidence is deliberately code-only. Header values and request content never
// enter profile state, logs, or context.
type Evidence struct {
	Code          EvidenceCode
	Authoritative bool
}

func (e Evidence) Validate() error {
	if !knownEvidence(e.Code) {
		return &Error{Code: CodeInvalidEvidence, Field: "evidence.code"}
	}
	return nil
}

type Ambiguity struct {
	Code AmbiguityCode
}

func (a Ambiguity) Validate() error {
	if !knownAmbiguity(a.Code) {
		return &Error{Code: CodeInvalidEvidence, Field: "ambiguity.code"}
	}
	return nil
}

// ClientProfile is the bounded source-client hint attached to an internal
// dispatch context. Surface is authoritative; ID is never routing authority.
type ClientProfile struct {
	ID          ClientProfileID
	Surface     Surface
	Confidence  uint8
	Reasons     []string
	Evidence    []Evidence
	Ambiguities []Ambiguity
}

func (p ClientProfile) Validate() error {
	if !knownProfile(p.ID) {
		return &Error{Code: CodeInvalidProfile, Field: "profile.id"}
	}
	if p.Confidence > 100 {
		return &Error{Code: CodeInvalidProfile, Field: "profile.confidence"}
	}
	if !p.Surface.IsValid() {
		return &Error{Code: CodeInvalidSurface, Field: "profile.surface"}
	}
	if len(p.Reasons) > MaxProfileReasons || len(p.Evidence) > MaxEvidence || len(p.Ambiguities) > MaxAmbiguities {
		return &Error{Code: CodeEvidenceBounds, Field: "profile.evidence"}
	}
	for _, reason := range p.Reasons {
		if !validCode(reason, MaxReasonBytes) {
			return &Error{Code: CodeInvalidEvidence, Field: "profile.reason"}
		}
	}
	for _, evidence := range p.Evidence {
		if err := evidence.Validate(); err != nil {
			return err
		}
	}
	for _, ambiguity := range p.Ambiguities {
		if err := ambiguity.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func NewClientProfile(id ClientProfileID, surface Surface, confidence uint8, reasons []string) (ClientProfile, error) {
	profile := ClientProfile{ID: id, Surface: surface, Confidence: confidence, Reasons: append([]string(nil), reasons...)}
	if err := profile.Validate(); err != nil {
		return ClientProfile{}, err
	}
	return profile, nil
}

func NewEvidence(code EvidenceCode, authoritative bool) (Evidence, error) {
	evidence := Evidence{Code: code, Authoritative: authoritative}
	if err := evidence.Validate(); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}

func NewAmbiguity(code AmbiguityCode) (Ambiguity, error) {
	ambiguity := Ambiguity{Code: code}
	if err := ambiguity.Validate(); err != nil {
		return Ambiguity{}, err
	}
	return ambiguity, nil
}

// ClassificationInput contains only the request facts needed for classification.
// Endpoint/body determine the source contract; headers are bounded hints.
type ClassificationInput struct {
	Endpoint string
	Method   string
	Surface  Surface
	Headers  http.Header
	Body     []byte
}

func (input ClassificationInput) Validate() error {
	if len(input.Endpoint) > MaxEndpointBytes {
		return &Error{Code: CodeInvalidInput, Field: "endpoint"}
	}
	if input.Surface != "" && !input.Surface.IsValid() {
		return &Error{Code: CodeInvalidSurface, Field: "surface"}
	}
	return nil
}

// Classify determines a profile without changing the request or its headers.
func Classify(input ClassificationInput) (ClientProfile, error) {
	if err := input.Validate(); err != nil {
		return ClientProfile{}, err
	}

	surface, surfaceEvidence, ambiguities := classifySurface(input)
	if !surface.IsValid() {
		return ClientProfile{}, &Error{Code: CodeInvalidSurface, Field: "surface"}
	}
	bodySurface, _, bodyKnown := classifyBody(input.Body)
	if bodyKnown {
		if bodySurface != surface {
			ambiguities = appendBoundedAmbiguity(ambiguities, AmbiguityEndpointBody)
		} else {
			surfaceEvidence = appendBoundedEvidence(surfaceEvidence, Evidence{Code: EvidenceBodySurface, Authoritative: true})
		}
	} else if len(input.Body) > MaxBodyScanBytes {
		ambiguities = appendBoundedAmbiguity(ambiguities, AmbiguityBodyUnavailable)
	}

	hintID, hintSurface, hintEvidence := headerHint(input.Headers)
	if hintID != "" && hintSurface != surface {
		ambiguities = appendBoundedAmbiguity(ambiguities, AmbiguityHeaderSurface)
		hintID = ""
	}

	id := ProfileUnknownStandard
	confidence := uint8(100)
	reasons := []string{"profile.unknown_standard"}
	if hintID != "" && !hasAmbiguity(ambiguities, AmbiguityEndpointBody) && !hasAmbiguity(ambiguities, AmbiguityUnsupportedSurface) {
		id = hintID
		confidence = 72
		reasons = []string{"profile.header_hint"}
		surfaceEvidence = appendBoundedEvidence(surfaceEvidence, hintEvidence...)
	}
	// Native Gemini is sufficiently distinctive to identify Gemini CLI from the
	// endpoint/body contract alone. A conflicting header still cannot override it.
	if surface == SurfaceGemini && bodyKnown && bodySurface == SurfaceGemini && hintID == "" && !hasAmbiguity(ambiguities, AmbiguityEndpointBody) {
		id = ProfileGeminiCLI
		confidence = 86
		reasons = []string{"profile.native_gemini_shape"}
		surfaceEvidence = appendBoundedEvidence(surfaceEvidence, Evidence{Code: EvidenceNativeGemini, Authoritative: true})
	}
	if id == ProfileUnknownStandard {
		ambiguities = appendBoundedAmbiguity(ambiguities, AmbiguityUnknownClient)
	}
	profile := ClientProfile{ID: id, Surface: surface, Confidence: confidence, Reasons: reasons, Evidence: surfaceEvidence, Ambiguities: ambiguities}
	if err := profile.Validate(); err != nil {
		return ClientProfile{}, err
	}
	return profile, nil
}

func ClassifyRequest(input ClassificationInput) (ClientProfile, error) { return Classify(input) }

func ClassifyClientProfile(input ClassificationInput) (ClientProfile, error) {
	return Classify(input)
}

func ClassifySurface(surface Surface, endpoint string, body []byte, headers http.Header) (ClientProfile, error) {
	return Classify(ClassificationInput{Surface: surface, Endpoint: endpoint, Body: body, Headers: headers})
}

// AttachProfile validates and carries only the classified profile in context.
func AttachProfile(ctx context.Context, input ClassificationInput) (context.Context, error) {
	if ctx == nil {
		return nil, &Error{Code: CodeContextInvalid, Field: "context"}
	}
	profile, err := Classify(input)
	if err != nil {
		return ctx, err
	}
	// Unknown-standard carries no routing authority or actionable dialect hint.
	// Preserve the original context on this hot path so cancellation identity and
	// existing dispatch contracts remain unchanged; callers can still invoke
	// Classify directly when they need the bounded evidence record.
	if profile.ID == ProfileUnknownStandard {
		return ctx, nil
	}
	return WithProfile(ctx, profile)
}

func WithProfile(ctx context.Context, profile ClientProfile) (context.Context, error) {
	if ctx == nil {
		return nil, &Error{Code: CodeContextInvalid, Field: "context"}
	}
	if err := profile.Validate(); err != nil {
		return ctx, err
	}
	profile.Reasons = append([]string(nil), profile.Reasons...)
	profile.Evidence = append([]Evidence(nil), profile.Evidence...)
	profile.Ambiguities = append([]Ambiguity(nil), profile.Ambiguities...)
	return context.WithValue(ctx, profileContextKey{}, profile), nil
}

func ProfileFromContext(ctx context.Context) (ClientProfile, bool) {
	if ctx == nil {
		return ClientProfile{}, false
	}
	profile, ok := ctx.Value(profileContextKey{}).(ClientProfile)
	return profile, ok
}

func ClientProfileFromContext(ctx context.Context) (ClientProfile, bool) {
	return ProfileFromContext(ctx)
}

type profileContextKey struct{}

type bodyShape struct {
	Messages   json.RawMessage `json:"messages"`
	Input      json.RawMessage `json:"input"`
	Contents   json.RawMessage `json:"contents"`
	Generation json.RawMessage `json:"generationConfig"`
	System     json.RawMessage `json:"systemInstruction"`
	Context    json.RawMessage `json:"context_management"`
	Include    json.RawMessage `json:"include"`
	Reasoning  json.RawMessage `json:"reasoning"`
	Tools      json.RawMessage `json:"tools"`
	MaxTokens  json.RawMessage `json:"max_tokens"`
}

func classifySurface(input ClassificationInput) (Surface, []Evidence, []Ambiguity) {
	endpointSurface := endpointSurface(input.Endpoint)
	if input.Surface != "" {
		evidence := []Evidence{{Code: EvidenceEndpointSurface, Authoritative: true}}
		ambiguities := []Ambiguity(nil)
		if endpointSurface != "" && endpointSurface != input.Surface {
			ambiguities = appendBoundedAmbiguity(ambiguities, AmbiguityEndpointBody)
		}
		return input.Surface, evidence, ambiguities
	}
	if endpointSurface != "" {
		return endpointSurface, []Evidence{{Code: EvidenceEndpointSurface, Authoritative: true}}, nil
	}
	bodySurface, _, bodyKnown := classifyBody(input.Body)
	if bodyKnown {
		return bodySurface, []Evidence{{Code: EvidenceBodySurface, Authoritative: true}}, nil
	}
	return SurfaceOpenAIChat, []Evidence{{Code: EvidenceStandardShape, Authoritative: false}}, []Ambiguity{{Code: AmbiguityUnsupportedSurface}}
}

func endpointSurface(endpoint string) Surface {
	path := strings.ToLower(strings.TrimSpace(endpoint))
	switch {
	case strings.Contains(path, "/messages"):
		return SurfaceAnthropic
	case strings.Contains(path, "/responses"):
		return SurfaceOpenAIResponses
	case strings.Contains(path, "/chat/completions"), strings.HasSuffix(path, "/completions"):
		return SurfaceOpenAIChat
	case strings.Contains(path, "generatecontent"), strings.Contains(path, "/gemini"):
		return SurfaceGemini
	default:
		return ""
	}
}

func classifyBody(body []byte) (Surface, []Evidence, bool) {
	if len(body) == 0 || len(body) > MaxBodyScanBytes {
		return "", nil, false
	}
	var shape bodyShape
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&shape); err != nil {
		return "", nil, false
	}
	switch {
	case len(shape.Contents) > 0:
		return SurfaceGemini, []Evidence{{Code: EvidenceBodySurface, Authoritative: true}}, true
	case len(shape.Messages) > 0 && len(shape.MaxTokens) > 0:
		return SurfaceAnthropic, []Evidence{{Code: EvidenceBodySurface, Authoritative: true}}, true
	case len(shape.Input) > 0:
		return SurfaceOpenAIResponses, []Evidence{{Code: EvidenceBodySurface, Authoritative: true}}, true
	case len(shape.Messages) > 0:
		return SurfaceOpenAIChat, []Evidence{{Code: EvidenceBodySurface, Authoritative: true}}, true
	default:
		return "", nil, false
	}
}

func headerHint(headers http.Header) (ClientProfileID, Surface, []Evidence) {
	ua := headerValue(headers, "User-Agent")
	xapp := headerValue(headers, "X-App")
	if xapp == "" {
		xapp = firstHeaderValue(headers, "X-Client-Name", "X-Client", "Client-Name", "OpenAI-Client")
	}
	intent := headerValue(headers, "OpenAI-Intent")
	for _, candidate := range []struct {
		value   string
		profile ClientProfileID
		surface Surface
		code    EvidenceCode
	}{
		{ua, ProfileClaudeCode, SurfaceAnthropic, EvidenceHeaderUserAgent},
		{xapp, ProfileClaudeCode, SurfaceAnthropic, EvidenceHeaderXApp},
		{ua, ProfileCodexCLI, SurfaceOpenAIResponses, EvidenceHeaderUserAgent},
		{xapp, ProfileCodexCLI, SurfaceOpenAIResponses, EvidenceHeaderXApp},
		{intent, ProfileCodexCLI, SurfaceOpenAIResponses, EvidenceHeaderIntent},
		{ua, ProfileGeminiCLI, SurfaceGemini, EvidenceHeaderUserAgent},
		{xapp, ProfileGeminiCLI, SurfaceGemini, EvidenceHeaderXApp},
		{ua, ProfileOpenAICompatible, SurfaceOpenAIChat, EvidenceHeaderUserAgent},
		{xapp, ProfileOpenAICompatible, SurfaceOpenAIChat, EvidenceHeaderXApp},
	} {
		if candidate.value != "" && hintMatches(candidate.profile, candidate.value) {
			return candidate.profile, candidate.surface, []Evidence{{Code: candidate.code, Authoritative: false}}
		}
	}
	return "", "", nil
}

func firstHeaderValue(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := headerValue(headers, name); value != "" {
			return value
		}
	}
	return ""
}

func headerValue(headers http.Header, name string) string {
	if headers == nil {
		return ""
	}
	if value := headers.Get(name); value != "" {
		return boundedHeader(value)
	}
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return boundedHeader(values[0])
		}
	}
	return ""
}

func hintMatches(profile ClientProfileID, value string) bool {
	value = strings.ToLower(value)
	switch profile {
	case ProfileClaudeCode:
		return strings.Contains(value, "claude-code") || strings.Contains(value, "claude code") || strings.Contains(value, "claude_code") || strings.Contains(value, "anthropic-cli")
	case ProfileCodexCLI:
		return strings.Contains(value, "codex")
	case ProfileGeminiCLI:
		return strings.Contains(value, "gemini-cli") || strings.Contains(value, "gemini cli") || strings.Contains(value, "gemini_cli") || strings.Contains(value, "google-gemini")
	case ProfileOpenAICompatible:
		for _, marker := range []string{"opencode", "cline", "cursor", "copilot", "continue", "openai-compatible"} {
			if strings.Contains(value, marker) {
				return true
			}
		}
	}
	return false
}

func boundedHeader(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > MaxHeaderBytes {
		return value[:MaxHeaderBytes]
	}
	return value
}

func appendBoundedEvidence(dst []Evidence, values ...Evidence) []Evidence {
	for _, value := range values {
		if len(dst) >= MaxEvidence {
			break
		}
		if value.Validate() == nil {
			dst = append(dst, value)
		}
	}
	return dst
}

func appendBoundedAmbiguity(dst []Ambiguity, code AmbiguityCode) []Ambiguity {
	if len(dst) < MaxAmbiguities && !hasAmbiguity(dst, code) {
		dst = append(dst, Ambiguity{Code: code})
	}
	return dst
}

func hasAmbiguity(values []Ambiguity, code AmbiguityCode) bool {
	for _, value := range values {
		if value.Code == code {
			return true
		}
	}
	return false
}

func knownProfile(profile ClientProfileID) bool {
	switch profile {
	case ProfileUnknownStandard, ProfileClaudeCode, ProfileCodexCLI, ProfileGeminiCLI, ProfileOpenAICompatible:
		return true
	default:
		return false
	}
}

func knownEvidence(code EvidenceCode) bool {
	switch code {
	case EvidenceEndpointSurface, EvidenceBodySurface, EvidenceHeaderUserAgent, EvidenceHeaderXApp, EvidenceHeaderIntent, EvidenceNativeGemini, EvidenceStandardShape:
		return true
	default:
		return false
	}
}

func knownAmbiguity(code AmbiguityCode) bool {
	switch code {
	case AmbiguityUnknownClient, AmbiguityEndpointBody, AmbiguityHeaderSurface, AmbiguityWeakHint, AmbiguityBodyUnavailable, AmbiguityUnsupportedSurface:
		return true
	default:
		return false
	}
}

func validCode(value string, max int) bool {
	if value == "" || len(value) > max {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
