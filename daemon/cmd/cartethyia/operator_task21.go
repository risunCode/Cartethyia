package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cartethyia/daemon"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/control/cacheplan"
	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility/corpus"
)

const (
	maxReplayFixtureBytes = 4 << 20
	maxReplayEvents       = 4096
)

type replayFixture struct {
	ID               string          `json:"id"`
	Request          json.RawMessage `json:"request"`
	ExpectedSemantic json.RawMessage `json:"expected_semantic"`
}

type replayReport struct {
	OK              bool   `json:"ok"`
	Command         string `json:"command"`
	Fixture         string `json:"fixture"`
	Surface         string `json:"surface"`
	Model           string `json:"model"`
	Stream          bool   `json:"stream"`
	Status          int    `json:"status"`
	MediaType       string `json:"media_type"`
	FirstFrame      bool   `json:"first_frame"`
	Terminal        string `json:"terminal"`
	SequenceValid   bool   `json:"sequence_valid"`
	SemanticDigest  string `json:"semantic_digest,omitempty"`
	UsagePresent    bool   `json:"usage_present"`
	CompactionItems int    `json:"compaction_items,omitempty"`
}

type replayValidation struct {
	firstFrame      bool
	terminal        string
	sequenceValid   bool
	usagePresent    bool
	compactionItems int
	semanticDigest  string
}

func compatReplayCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if ctx == nil {
		ctx = context.Background()
	}
	if stdin == nil {
		stdin = strings.NewReader("")
	}
	flags := newFlagSet("compat replay")
	input := flags.String("input", "", "fixture JSON path")
	endpoint := flags.String("url", "", "Cartethyia daemon origin")
	surface := flags.String("surface", "", "client surface")
	model := flags.String("model", "", "requested model (defaults to fixture model)")
	stream := flags.Bool("stream", false, "replay streaming response")
	timeout := flags.Duration("timeout", defaultProbeTimeout, "complete replay timeout")
	credentialEnv := flags.String("credential-env", "", "environment variable containing the daemon credential")
	credentialStdin := flags.Bool("credential-stdin", false, "read the daemon credential from stdin")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || strings.TrimSpace(*input) == "" || strings.TrimSpace(*endpoint) == "" || !validProbeSurface(*surface) || *timeout <= 0 {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat replay", ExitConfiguration, "configuration_failure", "invalid replay arguments")
	}
	if (*credentialEnv == "") == !*credentialStdin {
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", ExitConfiguration, "configuration_failure", "choose exactly one credential input")
	}
	fixture, requestBody, expectedDigest, expectedCompaction, expectedUsage, err := loadReplayFixture(*input)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", ExitConfiguration, "configuration_failure", "fixture is unavailable or malformed")
	}
	requestModel := fixtureModel(requestBody)
	if strings.TrimSpace(*model) == "" {
		*model = requestModel
	}
	if strings.TrimSpace(*model) == "" {
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", ExitConfiguration, "configuration_failure", "fixture model is required")
	}
	credential, err := readProbeCredential(*credentialEnv, *credentialStdin, stdin)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", ExitAuthorizationFailed, "authorization_failure", "replay credential is unavailable")
	}
	defer func() { credential = "" }()
	urlValue, err := probeEndpoint(*endpoint, *surface)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", ExitConfiguration, "configuration_failure", "daemon URL must be an HTTP(S) origin without credentials")
	}
	replayCtx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	validation, status, mediaType, err := executeReplay(replayCtx, urlValue, credential, requestBody, *surface, *stream, expectedDigest, expectedCompaction, expectedUsage)
	if err != nil {
		exit, code, message := classifyProbeError(err)
		return writeFailure(stdout, stderr, *jsonOutput, "compat replay", exit, code, message)
	}
	report := replayReport{OK: true, Command: "compat replay", Fixture: operatorLabel(fixture.ID), Surface: *surface, Model: operatorLabel(*model), Stream: *stream, Status: status, MediaType: mediaType, FirstFrame: validation.firstFrame, Terminal: validation.terminal, SequenceValid: validation.sequenceValid, SemanticDigest: validation.semanticDigest, UsagePresent: validation.usagePresent, CompactionItems: validation.compactionItems}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(report)
	} else {
		fmt.Fprintf(stdout, "replay %s fixture=%s status=%d terminal=%s first_frame=%t sequence=%t\n", report.Surface, report.Fixture, report.Status, report.Terminal, report.FirstFrame, report.SequenceValid)
	}
	return ExitSuccess
}

func loadReplayFixture(path string) (replayFixture, []byte, string, int, bool, error) {
	clean := filepath.Clean(path)
	if clean == "." || strings.Contains(clean, ".."+string(filepath.Separator)) {
		return replayFixture{}, nil, "", 0, false, errors.New("unsafe fixture path")
	}
	file, err := os.Open(clean)
	if err != nil {
		return replayFixture{}, nil, "", 0, false, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxReplayFixtureBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxReplayFixtureBytes {
		return replayFixture{}, nil, "", 0, false, errors.New("fixture size")
	}
	var fixture replayFixture
	if json.Unmarshal(raw, &fixture) != nil || len(fixture.Request) == 0 || !json.Valid(fixture.Request) {
		return replayFixture{}, nil, "", 0, false, errors.New("fixture JSON")
	}
	var body map[string]any
	if json.Unmarshal(fixture.Request, &body) != nil || body == nil {
		return replayFixture{}, nil, "", 0, false, errors.New("fixture request")
	}
	expectedDigest := ""
	expectedCompaction, expectedUsage := 0, false
	if len(fixture.ExpectedSemantic) != 0 && json.Valid(fixture.ExpectedSemantic) {
		var semantic corpus.Semantic
		if json.Unmarshal(fixture.ExpectedSemantic, &semantic) == nil {
			if digest, digestErr := corpus.SemanticDigest(semantic); digestErr == nil {
				expectedDigest = digest
			}
			expectedCompaction = semanticCompactionExpectation(semantic)
			expectedUsage = semantic.Usage != nil
		}
	}
	return fixture, append([]byte(nil), fixture.Request...), expectedDigest, expectedCompaction, expectedUsage, nil
}

func semanticCompactionExpectation(semantic corpus.Semantic) int {
	if strings.Contains(strings.ToLower(string(semantic.Operation.Kind)), "compaction") {
		return 1
	}
	return 0
}

func fixtureModel(body []byte) string {
	var value map[string]any
	if json.Unmarshal(body, &value) != nil {
		return ""
	}
	model, _ := value["model"].(string)
	return strings.TrimSpace(model)
}

func executeReplay(ctx context.Context, endpoint interface{ String() string }, credential string, payload []byte, surface string, stream bool, expectedDigest string, expectedCompaction int, expectedUsage bool) (replayValidation, int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return replayValidation{}, 0, "", probeError{kind: probeProtocol}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+credential)
	if surface == "anthropic-messages" {
		req.Header.Set("Anthropic-Version", "2023-06-01")
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return replayValidation{}, 0, "", probeError{kind: probeTimeout}
		}
		return replayValidation{}, 0, "", probeError{kind: probeProtocol}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return replayValidation{}, 0, "", probeError{kind: probeAuthorization}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return replayValidation{}, 0, "", replayCapabilityError(resp.Body)
	}
	mediaType, _, parseErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if parseErr != nil {
		return replayValidation{}, 0, "", probeError{kind: probeProtocol}
	}
	validation := replayValidation{sequenceValid: true}
	if stream {
		if !strings.EqualFold(mediaType, "text/event-stream") {
			return validation, 0, mediaType, probeError{kind: probeProtocol}
		}
		validation, err = validateReplayStream(ctx, resp.Body, surface, expectedCompaction, expectedUsage)
	} else {
		if !strings.EqualFold(mediaType, "application/json") {
			return validation, 0, mediaType, probeError{kind: probeProtocol}
		}
		validation, err = validateReplayJSON(resp.Body, surface, expectedCompaction, expectedUsage)
	}
	if err != nil {
		return validation, resp.StatusCode, mediaType, err
	}
	providedDigest := strings.TrimSpace(resp.Header.Get("X-Cartethyia-Semantic-Digest"))
	if providedDigest != "" && !validReplayDigest(providedDigest) {
		return validation, resp.StatusCode, mediaType, probeError{kind: probeProtocol}
	}
	if providedDigest == "" {
		providedDigest = validation.semanticDigest
	}
	if expectedDigest != "" && providedDigest != "" && !strings.EqualFold(expectedDigest, providedDigest) {
		return validation, resp.StatusCode, mediaType, probeError{kind: probeProtocol}
	}
	if providedDigest != "" {
		validation.semanticDigest = providedDigest
	}
	return validation, resp.StatusCode, mediaType, nil
}

func replayCapabilityError(body io.Reader) error {
	raw, _ := io.ReadAll(io.LimitReader(body, 64<<10))
	var envelope map[string]any
	if json.Unmarshal(raw, &envelope) == nil {
		var code string
		if value, ok := envelope["code"].(string); ok {
			code = value
		}
		if nested, ok := envelope["error"].(map[string]any); ok {
			if value, ok := nested["code"].(string); ok {
				code = value
			}
		}
		if strings.HasPrefix(code, "capability.remote_compaction_") {
			return probeError{kind: probeProtocol, code: operatorLabel(code)}
		}
	}
	return probeError{kind: probeProtocol}
}

func validateReplayJSON(body io.Reader, surface string, expectedCompaction int, expectedUsage bool) (replayValidation, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maxProbeFrameBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxProbeFrameBytes || !json.Valid(raw) {
		return replayValidation{}, probeError{kind: probeProtocol}
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return replayValidation{}, probeError{kind: probeProtocol}
	}
	validation := replayValidation{firstFrame: true, sequenceValid: true, usagePresent: containsKey(value, "usage"), compactionItems: countCompaction(value)}
	switch surface {
	case "openai-chat":
		choices, ok := value["choices"].([]any)
		if !ok || len(choices) == 0 {
			return validation, probeError{kind: probeProtocol}
		}
		choice, ok := choices[0].(map[string]any)
		if !ok {
			return validation, probeError{kind: probeProtocol}
		}
		if reason, ok := choice["finish_reason"].(string); !ok || reason == "" || reason == "error" {
			return validation, probeError{kind: probeProtocol}
		}
		validation.terminal = "finish_reason"
	case "openai-responses":
		status, _ := value["status"].(string)
		if status != "completed" {
			return validation, probeError{kind: probeProtocol}
		}
		validation.terminal = "response.completed"
	case "anthropic-messages":
		reason, _ := value["stop_reason"].(string)
		if reason == "" || reason == "error" {
			return validation, probeError{kind: probeProtocol}
		}
		validation.terminal = "message_stop"
	default:
		return validation, probeError{kind: probeProtocol}
	}
	if expectedCompaction > 0 && validation.compactionItems != expectedCompaction {
		return validation, probeError{kind: probeProtocol}
	}
	if expectedUsage && !validation.usagePresent {
		return validation, probeError{kind: probeProtocol}
	}
	if digest, ok := value["semantic_digest"].(string); ok {
		validation.semanticDigest = strings.TrimSpace(digest)
		if !validReplayDigest(validation.semanticDigest) {
			return validation, probeError{kind: probeProtocol}
		}
	}
	return validation, nil
}

func validateReplayStream(ctx context.Context, body io.Reader, surface string, expectedCompaction int, expectedUsage bool) (replayValidation, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), maxProbeLineBytes)
	var eventName, data string
	validation := replayValidation{sequenceValid: true}
	terminalCount := 0
	terminalDone := false
	lastSequence := -1.0
	sequence := make([]string, 0, 16)
	flush := func() error {
		if strings.TrimSpace(data) == "" {
			eventName, data = "", ""
			return nil
		}
		if len(sequence) >= maxReplayEvents {
			return probeError{kind: probeProtocol}
		}
		validation.firstFrame = true
		trimmed := strings.TrimSpace(data)
		if trimmed == "[DONE]" {
			if surface == "anthropic-messages" || terminalCount == 0 || terminalDone {
				return probeError{kind: probeProtocol}
			}
			terminalDone = true
			sequence = append(sequence, "[DONE]")
			eventName, data = "", ""
			return nil
		}
		if terminalDone || terminalCount > 0 {
			return probeError{kind: probeProtocol}
		}
		if !json.Valid([]byte(trimmed)) {
			return probeError{kind: probeProtocol}
		}
		var object map[string]any
		if json.Unmarshal([]byte(trimmed), &object) != nil {
			return probeError{kind: probeProtocol}
		}
		rawSequence, hasSequence := object["sequence_number"]
		if !hasSequence {
			rawSequence, hasSequence = object["sequence"]
		}
		if hasSequence {
			sequenceNumber, ok := rawSequence.(float64)
			if !ok || sequenceNumber < 0 || (lastSequence >= 0 && sequenceNumber <= lastSequence) {
				validation.sequenceValid = false
				return probeError{kind: probeProtocol}
			}
			lastSequence = sequenceNumber
		}
		typ, _ := object["type"].(string)
		if eventName != "" {
			typ = eventName
		}
		if typ == "" {
			typ = inferReplayEvent(surface, object)
		}
		if typ == "" {
			return probeError{kind: probeProtocol}
		}
		if terminalEvent(surface, typ, object) {
			terminalCount++
			validation.terminal = typ
		}
		if terminalCount > 1 {
			return probeError{kind: probeProtocol}
		}
		sequence = append(sequence, typ)
		validation.usagePresent = validation.usagePresent || containsKey(object, "usage")
		validation.compactionItems += countCompaction(object)
		if digest, ok := object["semantic_digest"].(string); ok {
			validation.semanticDigest = strings.TrimSpace(digest)
			if !validReplayDigest(validation.semanticDigest) {
				return probeError{kind: probeProtocol}
			}
		}
		eventName, data = "", ""
		return nil
	}
	for scanner.Scan() {
		if ctx.Err() != nil {
			return validation, probeError{kind: probeTimeout}
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return validation, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			eventName = value
		case "data":
			if len(data)+len(value) > maxProbeFrameBytes {
				return validation, probeError{kind: probeProtocol}
			}
			data += value
		}
	}
	if err := scanner.Err(); err != nil {
		return validation, probeError{kind: probeProtocol}
	}
	if err := flush(); err != nil {
		return validation, err
	}
	if !validation.firstFrame || terminalCount != 1 {
		return validation, probeError{kind: probeProtocol}
	}
	if expectedCompaction > 0 && validation.compactionItems != expectedCompaction {
		return validation, probeError{kind: probeProtocol}
	}
	if expectedUsage && !validation.usagePresent {
		return validation, probeError{kind: probeProtocol}
	}
	return validation, nil
}

func inferReplayEvent(surface string, object map[string]any) string {
	switch surface {
	case "openai-responses":
		if _, ok := object["status"]; ok {
			return "response.completed"
		}
	case "openai-chat":
		if _, ok := object["choices"]; ok {
			return "chat.chunk"
		}
	case "anthropic-messages":
		if _, ok := object["delta"]; ok {
			return "content_block_delta"
		}
	}
	return ""
}
func validReplayDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
func terminalEvent(surface, typ string, object map[string]any) bool {
	switch surface {
	case "openai-responses":
		return typ == "response.completed"
	case "anthropic-messages":
		return typ == "message_stop"
	case "openai-chat":
		if choices, ok := object["choices"].([]any); ok {
			for _, item := range choices {
				if choice, ok := item.(map[string]any); ok {
					if reason, ok := choice["finish_reason"].(string); ok && reason != "" && reason != "error" {
						return true
					}
				}
			}
		}
	}
	return false
}
func containsKey(value map[string]any, key string) bool {
	if _, ok := value[key]; ok {
		return true
	}
	for _, nested := range value {
		if child, ok := nested.(map[string]any); ok && containsKey(child, key) {
			return true
		}
		if list, ok := nested.([]any); ok {
			for _, item := range list {
				if child, ok := item.(map[string]any); ok && containsKey(child, key) {
					return true
				}
			}
		}
	}
	return false
}
func countCompaction(value map[string]any) int {
	count := 0
	if typ, ok := value["type"].(string); ok && (strings.Contains(strings.ToLower(typ), "compaction") || strings.Contains(strings.ToLower(typ), "compact")) {
		count++
	}
	for _, nested := range value {
		if child, ok := nested.(map[string]any); ok {
			count += countCompaction(child)
		}
		if list, ok := nested.([]any); ok {
			for _, item := range list {
				if child, ok := item.(map[string]any); ok {
					count += countCompaction(child)
				}
			}
		}
	}
	return count
}

func cacheCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "explain" {
		return writeFailure(stdout, stderr, wantsJSON(args), "cache explain", ExitConfiguration, "configuration_failure", "cache requires the explain subcommand")
	}
	flags := newFlagSet("cache explain")
	input := flags.String("input", "", "request JSON path")
	provider := flags.String("provider", "", "provider identifier")
	model := flags.String("model", "", "model identifier")
	surface := flags.String("surface", "", "target surface")
	policyID := flags.String("policy-id", "operator-policy-v1", "bounded policy identifier")
	generation := flags.Uint64("policy-generation", 1, "policy generation")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || strings.TrimSpace(*input) == "" || strings.TrimSpace(*provider) == "" || strings.TrimSpace(*model) == "" || strings.TrimSpace(*surface) == "" {
		return writeFailure(stdout, stderr, value(jsonOutput), "cache explain", ExitConfiguration, "configuration_failure", "--input, --provider, --model, and --surface are required")
	}
	raw, err := readBoundedJSONFile(*input, maxReplayFixtureBytes)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "cache explain", ExitConfiguration, "configuration_failure", "request fixture is unavailable or malformed")
	}
	var request map[string]any
	if json.Unmarshal(raw, &request) != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "cache explain", ExitConfiguration, "configuration_failure", "request fixture is unavailable or malformed")
	}
	providerUsage := boundedProviderUsage(request["provider_usage"])
	if nested, ok := request["request"].(map[string]any); ok {
		request = nested
	}
	protocol := cacheplan.ProtocolOpenAI
	if *surface == "anthropic-messages" {
		protocol = cacheplan.ProtocolAnthropic
	}
	if *surface != "openai-chat" && *surface != "openai-responses" && *surface != "anthropic-messages" {
		return writeFailure(stdout, stderr, *jsonOutput, "cache explain", ExitConfiguration, "configuration_failure", "unsupported cache surface")
	}
	policy := providers.CompatibilityPolicy{Generation: *generation, Cache: providers.CachePolicy{Prompt: providers.PromptCachePolicy{Supported: true, Key: protocol == cacheplan.ProtocolOpenAI, ExplicitBreakpoint: protocol == cacheplan.ProtocolAnthropic, MinPrefixBytes: 1, MarkerLocations: []string{"system", "tools", "message"}, TTLs: []time.Duration{time.Hour}}}}
	intent, planErr := cacheplan.PlanFinalWire(&cacheplan.FinalWireRequest{Protocol: protocol, Surface: *surface, ProviderID: *provider, ModelID: *model, TenantID: "operator", PolicyGeneration: *generation, Payload: request}, policy)
	if planErr != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "cache explain", ExitProtocolFailure, "protocol_failure", "cache planning failed")
	}
	boundary := "none"
	marker := "none"
	if len(intent.Breakpoints) > 0 {
		boundary = string(intent.Breakpoints[len(intent.Breakpoints)-1].Kind)
		marker = fmt.Sprintf("%s:%d", boundary, intent.Breakpoints[len(intent.Breakpoints)-1].BlockIndex)
	} else if intent.Eligible {
		boundary = "stable_prefix"
		marker = "prompt_cache_key"
	}
	digest := intent.Fingerprint
	if len(digest) > 16 {
		digest = digest[:16]
	}
	report := struct {
		OK             bool   `json:"ok"`
		Command        string `json:"command"`
		Eligible       bool   `json:"eligible"`
		Boundary       string `json:"boundary"`
		DigestPrefix   string `json:"digest_prefix,omitempty"`
		MarkerLocation string `json:"marker_location"`
		PolicyID       string `json:"policy_id"`
		DisabledCode   string `json:"disabled_code,omitempty"`
		Usage          *struct {
			CacheRead  int64 `json:"cache_read,omitempty"`
			CacheWrite int64 `json:"cache_write,omitempty"`
		} `json:"provider_usage,omitempty"`
	}{true, "cache explain", intent.Eligible, boundary, digest, marker, operatorLabel(*policyID), intent.DisabledCode, providerUsage}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(report)
	} else {
		fmt.Fprintf(stdout, "cache eligible=%t boundary=%s digest=%s marker=%s policy=%s\n", report.Eligible, report.Boundary, report.DigestPrefix, report.MarkerLocation, report.PolicyID)
	}
	return ExitSuccess
}

func readBoundedJSONFile(path string, limit int) ([]byte, error) {
	clean := filepath.Clean(path)
	if clean == "." || strings.Contains(clean, ".."+string(filepath.Separator)) {
		return nil, errors.New("unsafe path")
	}
	file, err := os.Open(clean)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil || len(raw) == 0 || len(raw) > limit || !json.Valid(raw) {
		return nil, errors.New("invalid JSON")
	}
	return raw, nil
}

func operatorLabel(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 {
		value = value[:64]
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '/' {
			continue
		}
		return "redacted"
	}
	return value
}

func boundedProviderUsage(value any) *struct {
	CacheRead  int64 `json:"cache_read,omitempty"`
	CacheWrite int64 `json:"cache_write,omitempty"`
} {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	read := func(key string) int64 {
		number, ok := object[key].(float64)
		if !ok || number < 0 || number > 1<<50 {
			return 0
		}
		return int64(number)
	}
	usage := &struct {
		CacheRead  int64 `json:"cache_read,omitempty"`
		CacheWrite int64 `json:"cache_write,omitempty"`
	}{CacheRead: read("cache_read"), CacheWrite: read("cache_write")}
	if usage.CacheRead == 0 && usage.CacheWrite == 0 {
		return nil
	}
	return usage
}

func accountsCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "readiness" {
		return writeFailure(stdout, stderr, wantsJSON(args), "accounts readiness", ExitConfiguration, "configuration_failure", "accounts requires the readiness subcommand")
	}
	flags := newFlagSet("accounts readiness")
	model := flags.String("model", "", "optional model filter")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		return writeFailure(stdout, stderr, value(jsonOutput), "accounts readiness", ExitConfiguration, "configuration_failure", "invalid readiness arguments")
	}
	cfg, err := loadDaemonConfig()
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "accounts readiness", ExitConfiguration, "configuration_failure", "configuration validation failed")
	}
	report, err := daemon.Readiness(ctx, cfg, strings.TrimSpace(*model))
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "accounts readiness", ExitDependency, "dependency_failure", "readiness snapshot is unavailable")
	}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(struct {
			OK        bool                   `json:"ok"`
			Command   string                 `json:"command"`
			Readiness daemon.ReadinessReport `json:"readiness"`
		}{true, "accounts readiness", report})
	} else {
		fmt.Fprintf(stdout, "readiness generation=%d candidates=%d\n", report.Generation, len(report.Candidates))
		for _, candidate := range report.Candidates {
			fmt.Fprintf(stdout, "%s/%s tier=%s", candidate.Provider, candidate.Model, candidate.Tier)
			if len(candidate.Exclusions) > 0 {
				fmt.Fprintf(stdout, " excluded=%s", strings.Join(candidate.Exclusions, ","))
			}
			if !candidate.RetryAt.IsZero() {
				fmt.Fprintf(stdout, " retry_at=%s", candidate.RetryAt.UTC().Format(time.RFC3339))
			}
			fmt.Fprintln(stdout)
		}
	}
	return ExitSuccess
}
