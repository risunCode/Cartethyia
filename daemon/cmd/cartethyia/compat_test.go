package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompatDetectIsRedactedAndReportsCanonicalFacts(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "fixture.json")
	if err := os.WriteFile(input, []byte(`{"model":"gpt-5.6","messages":[{"role":"user","content":"SECRET-PROMPT"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := compatDetectCommand(context.Background(), []string{"--input", input, "--surface", "openai-chat", "--json"}, &out, &errOut)
	if code != ExitSuccess || errOut.Len() != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	if strings.Contains(out.String(), "SECRET-PROMPT") || !strings.Contains(out.String(), `"surface":"openai-chat"`) {
		t.Fatalf("unexpected redacted detect output %q", out.String())
	}
}

func TestCompatTranslateDoesNotWriteBodyWithoutExplicitOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "fixture.json")
	if err := os.WriteFile(input, []byte(`{"model":"gpt-5.6","messages":[{"role":"user","content":"SECRET-PROMPT"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := compatTranslateCommand(context.Background(), []string{"--input", input, "--from", "openai-chat", "--to", "openai-responses", "--provider", "openai", "--model", "gpt-5.6", "--report-json"}, &out, &errOut)
	if code != ExitSuccess || errOut.Len() != 0 {
		t.Fatalf("code=%d stderr=%q output=%q", code, errOut.String(), out.String())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || strings.Contains(out.String(), "SECRET-PROMPT") {
		t.Fatalf("body was persisted or leaked: entries=%d output=%q", len(entries), out.String())
	}
}

func TestCompatTranslateRejectsUnsafeOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "fixture.json")
	if err := os.WriteFile(input, []byte(`{"model":"gpt-5.6","messages":[{"role":"user","content":"ok"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := compatTranslateCommand(context.Background(), []string{"--input", input, "--from", "openai-chat", "--to", "openai-responses", "--provider", "openai", "--model", "gpt-5.6", "--output", input}, &out, &errOut)
	if code != ExitConfiguration || !strings.Contains(errOut.String(), "output path") {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
}

func TestCompatMatrixCancellationAndMalformedFixture(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out, errOut bytes.Buffer
	if code := compatMatrixCommand(ctx, []string{"--corpus", t.TempDir(), "--json"}, &out, &errOut); code != ExitTimeout || !strings.Contains(out.String(), `"code":"timeout"`) {
		t.Fatalf("cancel code=%d output=%q", code, out.String())
	}
	bad := t.TempDir()
	if err := os.WriteFile(filepath.Join(bad, "manifest.json"), []byte(`{"schema_version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	if code := compatMatrixCommand(context.Background(), []string{"--corpus", bad, "--json"}, &out, &errOut); code != ExitProtocolFailure || strings.Contains(out.String(), "SECRET") {
		t.Fatalf("malformed code=%d output=%q", code, out.String())
	}
}

func TestCompatMatrixApprovedCorpusRunsAcceptanceGates(t *testing.T) {
	var out, errOut bytes.Buffer
	root := filepath.Join("..", "..", "testdata", "compatibility")
	if code := compatMatrixCommand(context.Background(), []string{"--corpus", root, "--json"}, &out, &errOut); code != ExitSuccess {
		t.Fatalf("approved corpus exit=%d stderr=%q output=%q", code, errOut.String(), out.String())
	}
	var report struct {
		OK    bool `json:"ok"`
		Score struct {
			Tier0Passed bool `json:"tier0_passed"`
			Tier1       struct {
				ScoreBasisPoints int `json:"score_basis_points"`
			} `json:"tier1"`
		} `json:"score"`
		Acceptance struct {
			Passed bool `json:"passed"`
			Tier0  struct {
				Passed bool `json:"passed"`
			} `json:"tier0"`
		} `json:"acceptance"`
	}
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if !report.OK || !report.Score.Tier0Passed || report.Score.Tier1.ScoreBasisPoints < 9500 || !report.Acceptance.Passed || !report.Acceptance.Tier0.Passed {
		t.Fatalf("acceptance gates failed: %s", out.Bytes())
	}
	if strings.Contains(out.String(), "request") || strings.Contains(out.String(), "content_digest") || strings.Contains(out.String(), "SECRET") {
		t.Fatalf("matrix report leaked fixture data: %s", out.Bytes())
	}
}

func TestCompatSubprocessRejectsSecretValuedFlags(t *testing.T) {
	const secret = "COMPAT-SECRET-SENTINEL"
	if os.Getenv("CARTETHYIA_COMPAT_HELPER") == "1" {
		code := run(context.Background(), []string{"compat", "detect", "--token=" + secret}, strings.NewReader(""), os.Stdout, os.Stderr)
		os.Exit(code)
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestCompatSubprocessRejectsSecretValuedFlags")
	cmd.Env = append(os.Environ(), "CARTETHYIA_COMPAT_HELPER=1")
	output, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != ExitConfiguration {
		t.Fatalf("subprocess error=%v output=%q", err, output)
	}
	if strings.Contains(string(output), secret) {
		t.Fatalf("secret leaked: %q", output)
	}
}
