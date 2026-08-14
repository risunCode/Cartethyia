package transforms

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func pipelineFixture() *NormalizedRequest {
	return &NormalizedRequest{
		Model:  "gpt-5",
		Source: contracts.ProtocolOpenAIChat,
		Messages: []NormalizedMessage{{
			Role: RoleUser,
			Content: []ContentBlock{
				{Type: BlockText, Text: "hello"},
				{Type: BlockToolUse, ToolName: "lookup", ToolArguments: `{"q":"hello"}`},
			},
		}},
		Images: []ImageReference{
			{Kind: ImageData, Value: "YWJj", MediaType: "IMAGE/PNG"},
			{Kind: ImageData, Value: "YWJj", MediaType: "image/png"},
		},
	}
}

func TestDefaultPipelinePreservesCanonicalSemanticsAndOrder(t *testing.T) {
	pipeline, err := NewDefaultPipeline()
	if err != nil {
		t.Fatalf("NewDefaultPipeline: %v", err)
	}
	input := pipelineFixture()
	result, err := pipeline.Apply(context.Background(), input, LosslessOnly)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result == nil || result.Request == nil {
		t.Fatal("pipeline returned nil result")
	}
	if got := result.Request.Messages[0].Content[1].ToolArguments; got != `{"q":"hello"}` {
		t.Fatalf("tool arguments changed unexpectedly: %q", got)
	}
	if len(result.Request.Images) != 1 {
		t.Fatalf("equivalent images = %d, want 1", len(result.Request.Images))
	}
	if len(result.Report.Diagnostics) != 8 {
		t.Fatalf("diagnostics = %d, want 8", len(result.Report.Diagnostics))
	}
	wantStages := []string{"protocol-validation", "lossless-normalization", "schema-tool-normalization", "tool-call-invariants", "lossy-transforms", "media-normalization", "stable-prefix", "cache-markers"}
	for i, want := range wantStages {
		if got := result.Report.Diagnostics[i].Stage; got != want {
			t.Fatalf("diagnostic[%d] stage = %q, want %q", i, got, want)
		}
	}
	if err := result.Report.Validate(); err != nil {
		t.Fatalf("report validation: %v", err)
	}
	if input.Messages[0].Content[1].ToolArguments != `{"q":"hello"}` {
		t.Fatal("pipeline mutated caller-owned request")
	}
}

func TestLossyStageHonorsPolicy(t *testing.T) {
	stage := LossyTransformStage{Transform: func(_ context.Context, req *NormalizedRequest) (*NormalizedRequest, error) {
		out := cloneNormalizedRequest(req)
		out.Messages[0].Content[0].Text = "short"
		return out, nil
	}}
	pipeline, err := NewPipeline(stage)
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}
	input := pipelineFixture()
	lossless, err := pipeline.Apply(context.Background(), input, LosslessOnly)
	if err != nil {
		t.Fatalf("lossless Apply: %v", err)
	}
	if got := lossless.Request.Messages[0].Content[0].Text; got != "hello" {
		t.Fatalf("lossless policy changed text: %q", got)
	}
	if got := lossless.Report.Diagnostics[0].Action; got != "bypass" {
		t.Fatalf("lossless action = %q, want bypass", got)
	}
	lossy, err := pipeline.Apply(context.Background(), input, AllowLossy)
	if err != nil {
		t.Fatalf("allow-lossy Apply: %v", err)
	}
	if got := lossy.Request.Messages[0].Content[0].Text; got != "short" {
		t.Fatalf("allow-lossy text = %q, want short", got)
	}
}

func TestPipelineRejectsStageAfterCacheMarkers(t *testing.T) {
	_, err := NewPipeline(CacheMarkerStage{}, IdentityStage{ID: "after-marker"})
	if err == nil {
		t.Fatal("expected marker-last error")
	}
	if !errors.Is(err, ErrMarkerLast) {
		t.Fatalf("error = %v, want ErrMarkerLast", err)
	}
	var transformErr *TransformError
	if !errors.As(err, &transformErr) || transformErr.CodeString() != string(CodeMarkerLast) {
		t.Fatalf("error code = %#v, want %q", transformErr, CodeMarkerLast)
	}
}

func TestCacheMarkerStageRejectsUnsupportedMarker(t *testing.T) {
	input := pipelineFixture()
	input.Messages[0].Content[0].CacheControl = "forever"
	pipeline, err := NewPipeline(CacheMarkerStage{})
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}
	_, err = pipeline.Apply(context.Background(), input, LosslessOnly)
	if err == nil || !errors.Is(err, ErrUnsupportedFeature) {
		t.Fatalf("error = %v, want unsupported feature", err)
	}
}

type oversizedDiagnosticStage struct{}

func (oversizedDiagnosticStage) Name() string { return "diagnostic-stage" }
func (oversizedDiagnosticStage) Apply(_ context.Context, req *NormalizedRequest, _ LossPolicy) (*NormalizedRequest, contracts.TransformDiagnostic, error) {
	return req, contracts.TransformDiagnostic{Action: "preserve", Reason: strings.Repeat("x", contracts.MaxFailureMessageBytes+1)}, nil
}

func TestPipelineBoundsDiagnostics(t *testing.T) {
	pipeline, err := NewPipeline(oversizedDiagnosticStage{})
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}
	_, err = pipeline.Apply(context.Background(), pipelineFixture(), LosslessOnly)
	if err == nil || !errors.Is(err, ErrInvalidDiagnostic) {
		t.Fatalf("error = %v, want invalid diagnostic", err)
	}
}
