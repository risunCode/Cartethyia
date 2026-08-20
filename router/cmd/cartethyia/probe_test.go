package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestReadProbeCredentialSources(t *testing.T) {
	t.Setenv("PROBE_TEST_KEY", "  secret-value  ")
	for _, tc := range []struct {
		name string
		env string
		stdin bool
		input string
		want string
		ok bool
	}{
		{"environment", "PROBE_TEST_KEY", false, "", "secret-value", true},
		{"stdin", "", true, "  stdin-secret\n", "stdin-secret", true},
		{"missing environment", "PROBE_MISSING_KEY", false, "", "", false},
		{"invalid environment", "bad-name", false, "", "", false},
		{"no source", "", false, "", "", false},
		{"empty stdin", "", true, " \n", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readProbeCredential(tc.env, tc.stdin, strings.NewReader(tc.input))
			if (err == nil) != tc.ok || got != tc.want {
				t.Fatalf("got %q, err=%v; want %q, success=%t", got, err, tc.want, tc.ok)
			}
		})
	}
}

func TestProbeEndpointAndPayload(t *testing.T) {
	for _, surface := range []string{"openai-chat", "openai-responses", "anthropic-messages"} {
		t.Run(surface, func(t *testing.T) {
			endpoint, err := probeEndpoint(" https://example.test/ ", surface)
			if err != nil || endpoint.Path == "" {
				t.Fatalf("endpoint=%v err=%v", endpoint, err)
			}
			payload, err := probePayload("model-x", surface, true)
			if err != nil || !bytes.Contains(payload, []byte(`"model":"model-x"`)) || !bytes.Contains(payload, []byte(`"stream":true`)) {
				t.Fatalf("payload=%s err=%v", payload, err)
			}
		})
	}
	for _, raw := range []string{"ftp://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test/?q=1", "https://example.test/#x"} {
		if endpoint, err := probeEndpoint(raw, "openai-chat"); err == nil || endpoint != nil {
			t.Fatalf("accepted invalid endpoint %q: %v", raw, endpoint)
		}
	}
	if _, err := probeEndpoint("https://example.test", "unsupported"); err == nil {
		t.Fatal("accepted unsupported surface")
	}
	if _, err := probePayload("model", "unsupported", false); err == nil {
		t.Fatal("accepted unsupported payload surface")
	}
}

func TestValidateProbeJSON(t *testing.T) {
	for _, tc := range []struct {
		name, surface, body, terminal string
		ok bool
	}{
		{"chat", "openai-chat", `{"choices":[{"finish_reason":"stop"}]}`, "finish_reason", true},
		{"responses", "openai-responses", `{"status":"completed"}`, "response.completed", true},
		{"anthropic", "anthropic-messages", `{"stop_reason":"end_turn"}`, "message_stop", true},
		{"chat missing choices", "openai-chat", `{}`, "", false},
		{"chat error", "openai-chat", `{"choices":[{"finish_reason":"error"}]}`, "", false},
		{"responses incomplete", "openai-responses", `{"status":"in_progress"}`, "", false},
		{"anthropic error", "anthropic-messages", `{"stop_reason":"error"}`, "", false},
		{"invalid json", "openai-chat", `{`, "", false},
		{"unknown surface", "other", `{}`, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := validateProbeJSON(strings.NewReader(tc.body), tc.surface)
			if (err == nil) != tc.ok || got != tc.terminal {
				t.Fatalf("got %q err=%v; want %q success=%t", got, err, tc.terminal, tc.ok)
			}
		})
	}
}

func TestInspectProbeEventAndStream(t *testing.T) {
	cases := []struct {
		surface, event, data string
		prior bool
		terminal string
		done, failed bool
	}{
		{"openai-chat", "", `{"choices":[{"finish_reason":"stop"}]}`, false, "finish_reason", false, false},
		{"openai-chat", "", `{"choices":[{"finish_reason":"error"}]}`, false, "", false, true},
		{"openai-responses", "response.completed", `{}`, false, "response.completed", false, false},
		{"openai-responses", "response.failed", `{}`, false, "", false, true},
		{"anthropic-messages", "message_stop", `{}`, false, "message_stop", true, false},
		{"openai-chat", "", `[DONE]`, false, "", false, true},
		{"openai-chat", "", `[DONE]`, true, "[DONE]", true, false},
		{"anthropic-messages", "", `[DONE]`, true, "", false, true},
		{"openai-chat", "", "not-json", false, "", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.surface+tc.event+tc.data, func(t *testing.T) {
			terminal, done, failed := inspectProbeEvent(tc.surface, tc.event, tc.data, tc.prior)
			if terminal != tc.terminal || done != tc.done || failed != tc.failed {
				t.Fatalf("got %q,%t,%t", terminal, done, failed)
			}
		})
	}
	body := "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	first, terminal, err := validateProbeStream(context.Background(), strings.NewReader(body), "openai-chat")
	if err != nil || !first || terminal != "[DONE]" {
		t.Fatalf("stream got first=%t terminal=%q err=%v", first, terminal, err)
	}
	if _, _, err := validateProbeStream(context.Background(), strings.NewReader("data: {}\n\n"), "openai-chat"); err == nil {
		t.Fatal("accepted stream without terminal")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := validateProbeStream(ctx, strings.NewReader("data: {}\n\n"), "openai-chat"); !errors.As(err, new(probeError)) {
		t.Fatalf("expected typed timeout/protocol error, got %v", err)
	}
}

func TestClassifyProbeError(t *testing.T) {
	for _, tc := range []struct {
		err error
		code string
		wantExit int
		wantCode string
	}{
		{errors.New("network"), "protocol_failure", ExitProtocolFailure, "protocol_failure"},
		{probeError{kind: probeTimeout}, "timeout", ExitTimeout, "timeout"},
		{probeError{kind: probeAuthorization}, "authorization_failure", ExitAuthorizationFailed, "authorization_failure"},
		{probeError{kind: probeProtocol, code: "custom"}, "custom", ExitProtocolFailure, "custom"},
	} {
		exit, code, _ := classifyProbeError(tc.err)
		if exit != tc.wantExit || code != tc.wantCode {
			t.Fatalf("got exit=%d code=%q", exit, code)
		}
	}
	if (probeError{}).Error() != "probe failed" {
		t.Fatal("unexpected probe error text")
	}
}
