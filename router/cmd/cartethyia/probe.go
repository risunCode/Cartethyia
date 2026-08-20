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
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	defaultProbeTimeout = 30 * time.Second
	maxProbeSecretBytes = 16 << 10
	maxProbeFrameBytes  = 1 << 20
	maxProbeLineBytes   = 64 << 10
)

type probeHTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

var probeClient probeHTTPDoer = &http.Client{
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

type probeReport struct {
	OK         bool   `json:"ok"`
	Command    string `json:"command"`
	Surface    string `json:"surface"`
	Model      string `json:"model"`
	Stream     bool   `json:"stream"`
	Status     int    `json:"status"`
	MediaType  string `json:"media_type"`
	FirstFrame bool   `json:"first_frame,omitempty"`
	Terminal   string `json:"terminal"`
}

type probeErrorKind int

const (
	probeProtocol probeErrorKind = iota + 1
	probeTimeout
	probeAuthorization
)

type probeError struct {
	kind probeErrorKind
	code string
}

func (e probeError) Error() string { return "probe failed" }

func probeCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := newFlagSet("probe")
	daemonURL := flags.String("url", "", "Cartethyia daemon origin")
	model := flags.String("model", "", "requested model")
	surface := flags.String("surface", "", "client surface")
	stream := flags.Bool("stream", false, "probe streaming response")
	timeout := flags.Duration("timeout", defaultProbeTimeout, "complete probe timeout")
	credentialEnv := flags.String("credential-env", "", "environment variable containing the daemon credential")
	credentialStdin := flags.Bool("credential-stdin", false, "read the daemon credential from stdin")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || strings.TrimSpace(*daemonURL) == "" || strings.TrimSpace(*model) == "" || !validProbeSurface(*surface) || *timeout <= 0 {
		return writeFailure(stdout, stderr, value(jsonOutput), "probe", ExitConfiguration, "configuration_failure", "invalid probe arguments")
	}
	if (*credentialEnv == "") == !*credentialStdin {
		return writeFailure(stdout, stderr, *jsonOutput, "probe", ExitConfiguration, "configuration_failure", "choose exactly one credential input")
	}
	credential, err := readProbeCredential(*credentialEnv, *credentialStdin, stdin)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "probe", ExitAuthorizationFailed, "authorization_failure", "probe credential is unavailable")
	}
	endpoint, err := probeEndpoint(*daemonURL, *surface)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "probe", ExitConfiguration, "configuration_failure", "daemon URL must be an HTTP(S) origin without credentials")
	}
	payload, err := probePayload(*model, *surface, *stream)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "probe", ExitConfiguration, "configuration_failure", "probe payload construction failed")
	}
	probeCtx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	report, err := executeProbe(probeCtx, endpoint, credential, payload, *model, *surface, *stream)
	credential = ""
	if err != nil {
		exit, code, message := classifyProbeError(err)
		return writeFailure(stdout, stderr, *jsonOutput, "probe", exit, code, message)
	}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(report)
	} else {
		fmt.Fprintf(stdout, "probe %s status=%d media=%s terminal=%s", report.Surface, report.Status, report.MediaType, report.Terminal)
		if report.Stream {
			fmt.Fprintf(stdout, " first_frame=%t", report.FirstFrame)
		}
		fmt.Fprintln(stdout)
	}
	return ExitSuccess
}

func readProbeCredential(environmentName string, fromStdin bool, stdin io.Reader) (string, error) {
	if environmentName != "" {
		if !safeEnvironmentName.MatchString(environmentName) {
			return "", errors.New("invalid environment name")
		}
		value, ok := os.LookupEnv(environmentName)
		value = strings.TrimSpace(value)
		if !ok || value == "" || len(value) > maxProbeSecretBytes {
			return "", errors.New("credential unavailable")
		}
		return value, nil
	}
	if !fromStdin {
		return "", errors.New("credential source required")
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxProbeSecretBytes+1))
	if err != nil || len(raw) > maxProbeSecretBytes {
		return "", errors.New("credential unavailable")
	}
	value := strings.TrimSpace(string(raw))
	for index := range raw {
		raw[index] = 0
	}
	if value == "" {
		return "", errors.New("credential unavailable")
	}
	return value, nil
}

func probeEndpoint(raw, surface string) (*url.URL, error) {
	base, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid daemon origin")
	}
	if base.Path != "" && base.Path != "/" {
		return nil, errors.New("daemon URL must be an origin")
	}
	switch surface {
	case "openai-chat":
		base.Path = "/v1/chat/completions"
	case "openai-responses":
		base.Path = "/v1/responses"
	case "anthropic-messages":
		base.Path = "/v1/messages"
	default:
		return nil, errors.New("unsupported surface")
	}
	return base, nil
}

func probePayload(model, surface string, stream bool) ([]byte, error) {
	var payload any
	switch surface {
	case "openai-chat":
		payload = map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Reply with OK."}}, "stream": stream, "max_tokens": 8}
	case "openai-responses":
		payload = map[string]any{"model": model, "input": "Reply with OK.", "stream": stream, "max_output_tokens": 8}
	case "anthropic-messages":
		payload = map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Reply with OK."}}, "stream": stream, "max_tokens": 8}
	default:
		return nil, errors.New("unsupported surface")
	}
	return json.Marshal(payload)
}

func executeProbe(ctx context.Context, endpoint *url.URL, credential string, payload []byte, model, surface string, stream bool) (probeReport, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return probeReport{}, probeError{kind: probeProtocol}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+credential)
	if surface == "anthropic-messages" {
		request.Header.Set("Anthropic-Version", "2023-06-01")
	}
	response, err := probeClient.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return probeReport{}, probeError{kind: probeTimeout}
		}
		return probeReport{}, probeError{kind: probeProtocol}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return probeReport{}, probeError{kind: probeAuthorization}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return probeReport{}, probeError{kind: probeProtocol}
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil {
		return probeReport{}, probeError{kind: probeProtocol}
	}
	report := probeReport{OK: true, Command: "probe", Surface: surface, Model: model, Stream: stream, Status: response.StatusCode, MediaType: mediaType}
	if stream {
		if !strings.EqualFold(mediaType, "text/event-stream") {
			return probeReport{}, probeError{kind: probeProtocol}
		}
		firstFrame, terminal, err := validateProbeStream(ctx, response.Body, surface)
		if err != nil {
			return probeReport{}, err
		}
		report.FirstFrame, report.Terminal = firstFrame, terminal
		return report, nil
	}
	if !strings.EqualFold(mediaType, "application/json") {
		return probeReport{}, probeError{kind: probeProtocol}
	}
	terminal, err := validateProbeJSON(response.Body, surface)
	if err != nil {
		return probeReport{}, err
	}
	report.Terminal = terminal
	return report, nil
}

func validateProbeJSON(body io.Reader, surface string) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maxProbeFrameBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxProbeFrameBytes || !json.Valid(raw) {
		return "", probeError{kind: probeProtocol}
	}
	var envelope map[string]any
	if json.Unmarshal(raw, &envelope) != nil {
		return "", probeError{kind: probeProtocol}
	}
	switch surface {
	case "openai-chat":
		choices, ok := envelope["choices"].([]any)
		if !ok || len(choices) == 0 {
			return "", probeError{kind: probeProtocol}
		}
		choice, ok := choices[0].(map[string]any)
		if !ok || choice["finish_reason"] == nil || choice["finish_reason"] == "error" {
			return "", probeError{kind: probeProtocol}
		}
		return "finish_reason", nil
	case "openai-responses":
		if status, _ := envelope["status"].(string); status != "completed" {
			return "", probeError{kind: probeProtocol}
		}
		return "response.completed", nil
	case "anthropic-messages":
		if reason, _ := envelope["stop_reason"].(string); reason == "" || reason == "error" {
			return "", probeError{kind: probeProtocol}
		}
		return "message_stop", nil
	default:
		return "", probeError{kind: probeProtocol}
	}
}

func validateProbeStream(ctx context.Context, body io.Reader, surface string) (bool, string, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), maxProbeLineBytes)
	var eventName string
	var data strings.Builder
	firstFrame := false
	terminalSeen := false
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return firstFrame, "", probeError{kind: probeTimeout}
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if data.Len() == 0 {
				eventName = ""
				continue
			}
			firstFrame = true
			terminal, done, failed := inspectProbeEvent(surface, eventName, data.String(), terminalSeen)
			if failed {
				return firstFrame, "", probeError{kind: probeProtocol}
			}
			if terminal != "" && terminal != "[DONE]" {
				terminalSeen = true
			}
			if done {
				return firstFrame, terminal, nil
			}
			eventName = ""
			data.Reset()
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
			if data.Len() != 0 {
				data.WriteByte('\n')
			}
			if data.Len()+len(value) > maxProbeFrameBytes {
				return firstFrame, "", probeError{kind: probeProtocol}
			}
			data.WriteString(value)
		}
	}
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return firstFrame, "", probeError{kind: probeTimeout}
	}
	return firstFrame, "", probeError{kind: probeProtocol}
}

func inspectProbeEvent(surface, eventName, data string, priorTerminal bool) (terminal string, done, failed bool) {
	data = strings.TrimSpace(data)
	if data == "[DONE]" {
		if surface == "anthropic-messages" || !priorTerminal {
			return "", false, true
		}
		return "[DONE]", true, false
	}
	if !json.Valid([]byte(data)) {
		return "", false, true
	}
	var envelope struct {
		Type    string `json:"type"`
		Choices []struct {
			FinishReason any `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal([]byte(data), &envelope) != nil {
		return "", false, true
	}
	typ := eventName
	if typ == "" {
		typ = envelope.Type
	}
	switch surface {
	case "openai-chat":
		for _, choice := range envelope.Choices {
			if reason, ok := choice.FinishReason.(string); ok && reason != "" {
				if reason == "error" {
					return "", false, true
				}
				return "finish_reason", false, false
			}
		}
	case "openai-responses":
		if typ == "response.failed" || typ == "response.incomplete" || typ == "error" {
			return "", false, true
		}
		if typ == "response.completed" {
			return "response.completed", false, false
		}
	case "anthropic-messages":
		if typ == "error" {
			return "", false, true
		}
		if typ == "message_stop" {
			return "message_stop", true, false
		}
	}
	return "", false, false
}

func classifyProbeError(err error) (int, string, string) {
	var typed probeError
	if !errors.As(err, &typed) {
		return ExitProtocolFailure, "protocol_failure", "daemon probe failed"
	}
	switch typed.kind {
	case probeTimeout:
		return ExitTimeout, "timeout", "daemon probe timed out or was canceled"
	case probeAuthorization:
		return ExitAuthorizationFailed, "authorization_failure", "daemon authorization failed"
	default:
		if typed.code != "" {
			return ExitProtocolFailure, typed.code, "daemon response violated the selected protocol"
		}
		return ExitProtocolFailure, "protocol_failure", "daemon response violated the selected protocol"
	}
}
