package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestTask21SubprocessRejectsSecretValuedReplayFlag(t *testing.T) {
	const secret = "credential-TASK21-SUBPROCESS-SENTINEL"
	if os.Getenv("CARTETHYIA_TASK21_HELPER") == "1" {
		code := run(context.Background(), []string{"compat", "replay", "--token=" + secret}, strings.NewReader(""), os.Stdout, os.Stderr)
		os.Exit(code)
	}
	command := exec.Command(os.Args[0], "-test.run=TestTask21SubprocessRejectsSecretValuedReplayFlag")
	command.Env = append(os.Environ(), "CARTETHYIA_TASK21_HELPER=1")
	output, err := command.CombinedOutput()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != ExitConfiguration {
		t.Fatalf("subprocess error=%v output=%q", err, output)
	}
	if strings.Contains(string(output), secret) {
		t.Fatalf("secret-valued replay flag leaked: %q", output)
	}
}

func TestTask21ReplayValidationDoesNotEmitResponseBody(t *testing.T) {
	body := `{"id":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"response-body-SENTINEL"}]}],"usage":{"input_tokens":1}}`
	validation, err := validateReplayJSON(strings.NewReader(body), "openai-responses", 0, true)
	if err != nil || !validation.firstFrame || !validation.sequenceValid || !validation.usagePresent {
		t.Fatalf("validation=%#v err=%v", validation, err)
	}
	if validation.semanticDigest != "" {
		t.Fatalf("unexpected body-derived digest: %q", validation.semanticDigest)
	}
}

func TestTask21ReplayCompactV1AndV2RequireExactlyOneItem(t *testing.T) {
	v1 := `{"status":"completed","output":[{"type":"compaction","encrypted_content":"summary"}],"usage":{"input_tokens":4}}`
	if validation, err := validateReplayJSON(strings.NewReader(v1), "openai-responses", 1, true); err != nil || validation.compactionItems != 1 || validation.terminal != "response.completed" {
		t.Fatalf("v1 validation=%#v err=%v", validation, err)
	}
	v2 := "event: response.output_item.added\ndata: {\"type\":\"compaction\",\"sequence_number\":1}\n\n" +
		"event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"usage\":{\"input_tokens\":4}}\n\n"
	if validation, err := validateReplayStream(context.Background(), strings.NewReader(v2), "openai-responses", 1, true); err != nil || validation.compactionItems != 1 || validation.terminal != "response.completed" || !validation.sequenceValid {
		t.Fatalf("v2 validation=%#v err=%v", validation, err)
	}
	duplicate := `{"status":"completed","output":[{"type":"compaction"},{"type":"compaction"}],"usage":{"input_tokens":4}}`
	if _, err := validateReplayJSON(strings.NewReader(duplicate), "openai-responses", 1, true); err == nil {
		t.Fatal("duplicate compaction item was accepted")
	}
}
