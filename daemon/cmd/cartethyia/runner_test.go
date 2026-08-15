package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon"
)

type cliRuntimeStub struct {
	start func(context.Context) error
	close func(context.Context) error
}

func (s cliRuntimeStub) Start(ctx context.Context) error {
	if s.start != nil {
		return s.start(ctx)
	}
	return nil
}

func (s cliRuntimeStub) Close(ctx context.Context) error {
	if s.close != nil {
		return s.close(ctx)
	}
	return nil
}

func TestCLIRunnerExitCodesAndNoArgumentServe(t *testing.T) {
	originalLoad, originalNew, originalDoctor, originalExplain := loadDaemonConfig, newDaemonRuntime, runDoctor, explainRoute
	t.Cleanup(func() {
		loadDaemonConfig, newDaemonRuntime, runDoctor, explainRoute = originalLoad, originalNew, originalDoctor, originalExplain
	})
	loadDaemonConfig = func() (daemon.Config, error) { return daemon.Config{}, nil }
	started, closed := 0, 0
	newDaemonRuntime = func(daemon.Config) (daemonRuntime, error) {
		return cliRuntimeStub{
			start: func(context.Context) error { started++; return nil },
			close: func(context.Context) error { closed++; return nil },
		}, nil
	}
	if code := run(context.Background(), nil, nil, &bytes.Buffer{}, &bytes.Buffer{}); code != ExitSuccess || started != 1 || closed != 1 {
		t.Fatalf("no-argument serve code=%d started=%d closed=%d", code, started, closed)
	}

	runDoctor = func(context.Context, daemon.Config) (daemon.DoctorReport, error) {
		return daemon.DoctorReport{}, errors.New("unavailable")
	}
	if code := run(context.Background(), []string{"doctor"}, nil, &bytes.Buffer{}, &bytes.Buffer{}); code != ExitDependency {
		t.Fatalf("doctor dependency exit=%d", code)
	}
	explainRoute = func(context.Context, daemon.Config, string, string) (daemon.RouteExplanation, error) {
		return daemon.RouteExplanation{}, nil
	}
	if code := run(context.Background(), []string{"route", "explain", "--model", "missing", "--surface", "openai-chat"}, nil, &bytes.Buffer{}, &bytes.Buffer{}); code != ExitRouteUnavailable {
		t.Fatalf("route unavailable exit=%d", code)
	}
	if code := run(context.Background(), []string{"unknown"}, nil, &bytes.Buffer{}, &bytes.Buffer{}); code != ExitConfiguration {
		t.Fatalf("configuration exit=%d", code)
	}
}

func TestCLIExplainUsesReadOnlyDiagnosticAndRedactsOutput(t *testing.T) {
	originalLoad, originalExplain := loadDaemonConfig, explainRoute
	t.Cleanup(func() { loadDaemonConfig, explainRoute = originalLoad, originalExplain })
	loadDaemonConfig = func() (daemon.Config, error) { return daemon.Config{}, nil }
	calls := 0
	explainRoute = func(_ context.Context, _ daemon.Config, model, surface string) (daemon.RouteExplanation, error) {
		calls++
		return daemon.RouteExplanation{
			RequestedModel: model, Surface: surface, Generation: 4, Strategy: "single",
			Candidates: []daemon.RouteCandidateDiagnostic{{Position: 1, ProviderID: "openai", UpstreamModel: "gpt-4o", AccountID: "account_0123456789ab", State: "healthy"}},
		}, nil
	}
	var out, errOut bytes.Buffer
	code := run(context.Background(), []string{"route", "explain", "--model", "gpt-4o", "--surface", "openai-chat", "--json"}, nil, &out, &errOut)
	if code != ExitSuccess || calls != 1 || errOut.Len() != 0 {
		t.Fatalf("code=%d calls=%d stderr=%q", code, calls, errOut.String())
	}
	if strings.Contains(out.String(), "raw-account-id") || !strings.Contains(out.String(), "account_0123456789ab") {
		t.Fatalf("unexpected explain output %q", out.String())
	}
}

func TestCLIProbeRedactionAuthorizationAndProtocolExits(t *testing.T) {
	const secret = "credential-SENTINEL-never-print"
	t.Setenv("CARTETHYIA_TEST_PROBE_KEY", secret)
	for _, test := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{name: "authorization", status: http.StatusUnauthorized, body: secret, want: ExitAuthorizationFailed},
		{name: "protocol", status: http.StatusOK, body: `{"choices":`, want: ExitProtocolFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Bearer "+secret {
					t.Errorf("authorization header mismatch")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			var out, errOut bytes.Buffer
			code := probeCommand(context.Background(), []string{"--url", server.URL, "--model", "gpt-4o", "--surface", "openai-chat", "--credential-env", "CARTETHYIA_TEST_PROBE_KEY", "--json"}, strings.NewReader(""), &out, &errOut)
			if code != test.want {
				t.Fatalf("code=%d want=%d output=%q", code, test.want, out.String())
			}
			if strings.Contains(out.String(), secret) || strings.Contains(errOut.String(), secret) || strings.Contains(out.String(), test.body) {
				t.Fatalf("probe leaked credential or body: stdout=%q stderr=%q", out.String(), errOut.String())
			}
		})
	}
}

func TestCLIProbeStreamingFirstFrameAndMalformedTerminal(t *testing.T) {
	t.Setenv("CARTETHYIA_TEST_PROBE_KEY", "test-only-key")
	for _, test := range []struct {
		name string
		body string
		want int
	}{
		{name: "first frame and terminal", body: "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", want: ExitSuccess},
		{name: "malformed terminal", body: "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\n", want: ExitProtocolFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				_, _ = fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			var out, errOut bytes.Buffer
			code := probeCommand(context.Background(), []string{"--url", server.URL, "--model", "gpt-4o", "--surface", "openai-chat", "--stream", "--credential-env", "CARTETHYIA_TEST_PROBE_KEY", "--json"}, strings.NewReader(""), &out, &errOut)
			if code != test.want {
				t.Fatalf("code=%d want=%d output=%q stderr=%q", code, test.want, out.String(), errOut.String())
			}
			if test.want == ExitSuccess && !strings.Contains(out.String(), `"first_frame":true`) {
				t.Fatalf("first frame not reported: %q", out.String())
			}
		})
	}
}

func TestCLIProbeCancellationReturnsTimeout(t *testing.T) {
	t.Setenv("CARTETHYIA_TEST_PROBE_KEY", "test-only-key")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	code := probeCommand(ctx, []string{"--url", "http://127.0.0.1:1", "--model", "gpt-4o", "--surface", "openai-chat", "--credential-env", "CARTETHYIA_TEST_PROBE_KEY", "--timeout", time.Second.String(), "--json"}, strings.NewReader(""), &out, &bytes.Buffer{})
	if code != ExitTimeout || !strings.Contains(out.String(), `"code":"timeout"`) {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
}

func TestCLISubprocessRejectsSecretValuedFlagsWithoutLeak(t *testing.T) {
	const secret = "credential-SUBPROCESS-SENTINEL"
	if os.Getenv("CARTETHYIA_CLI_HELPER") == "1" {
		code := run(context.Background(), []string{"probe", "--api-key=" + secret}, strings.NewReader(""), os.Stdout, os.Stderr)
		os.Exit(code)
	}
	command := exec.Command(os.Args[0], "-test.run=TestCLISubprocessRejectsSecretValuedFlagsWithoutLeak")
	command.Env = append(os.Environ(), "CARTETHYIA_CLI_HELPER=1")
	output, err := command.CombinedOutput()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != ExitConfiguration {
		t.Fatalf("subprocess error=%v output=%q", err, output)
	}
	if strings.Contains(string(output), secret) {
		t.Fatalf("subprocess output leaked secret-valued flag: %q", output)
	}
}
