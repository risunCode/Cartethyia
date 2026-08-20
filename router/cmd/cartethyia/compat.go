package main

import (
	"context"
	"encoding/json"
	"errors"

	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/protocol/compatibility/corpus"
	"github.com/cartethyia/daemon/internal/protocol/codec"
)

const maxCompatInputBytes = 256 << 10

type compatInspection struct {
	Body     []byte
	Surface  protocol.Surface
	Profile  protocol.ClientProfile
	Request  *codec.NormalizedRequest
	Features []protocol.Feature
	Raw      map[string]any
}

type compatDetectReport struct {
	OK                bool                          `json:"ok"`
	Command           string                        `json:"command"`
	Surface           string                        `json:"surface"`
	Profile           string                        `json:"profile"`
	Confidence        uint8                         `json:"confidence"`
	Operation         string                        `json:"operation"`
	CompactionVersion string                        `json:"compaction_version,omitempty"`
	Features          []string                      `json:"features"`
	Ambiguities       []protocol.AmbiguityCode `json:"ambiguities,omitempty"`
	Evidence          []protocol.EvidenceCode  `json:"evidence,omitempty"`
}

type compatDisposition struct {
	SourcePath string `json:"source_path"`
	TargetPath string `json:"target_path,omitempty"`
	Feature    string `json:"feature,omitempty"`
	Action     string `json:"action"`
	RuleID     string `json:"rule_id,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type compatTranslateReport struct {
	OK            bool                `json:"ok"`
	Command       string              `json:"command"`
	SourceSurface string              `json:"source_surface"`
	TargetSurface string              `json:"target_surface"`
	Profile       string              `json:"profile"`
	Provider      string              `json:"provider"`
	Model         string              `json:"model"`
	Operation     string              `json:"operation"`
	Dispositions  []compatDisposition `json:"dispositions"`
	OutputPath    string              `json:"output_path,omitempty"`
	Capability    string              `json:"capability,omitempty"`
	Alternatives  []string            `json:"alternatives,omitempty"`
}

type compatMatrixReport struct {
	OK              bool                    `json:"ok"`
	Command         string                  `json:"command"`
	Score           compatScoreReport       `json:"score"`
	GroupedFailures map[string]int          `json:"grouped_failures,omitempty"`
	Acceptance      corpus.AcceptanceReport `json:"acceptance"`
}

type compatScoreReport struct {
	SchemaVersion     int                         `json:"schema_version"`
	CorpusGeneration  int                         `json:"corpus_generation"`
	TargetBasisPoints int                         `json:"target_basis_points"`
	Passed            bool                        `json:"passed"`
	Tier0Passed       bool                        `json:"tier0_passed"`
	Tier1             corpus.Breakdown            `json:"tier1"`
	Tier0             corpus.Breakdown            `json:"tier0"`
	Total             corpus.Breakdown            `json:"total"`
	ByProfile         map[string]corpus.Breakdown `json:"by_profile"`
	BySourceSurface   map[string]corpus.Breakdown `json:"by_source_surface"`
	ByTargetSurface   map[string]corpus.Breakdown `json:"by_target_surface"`
	ByProvider        map[string]corpus.Breakdown `json:"by_provider"`
	ByFeature         map[string]corpus.Breakdown `json:"by_feature"`
	Failures          []corpus.Failure            `json:"failures,omitempty"`
	FailureCount      int                         `json:"failure_count"`
	FailuresTruncated bool                        `json:"failures_truncated,omitempty"`
	FailureGroups     map[string]int              `json:"failure_groups,omitempty"`
}

func compatCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if ctx == nil {
		ctx = context.Background()
	}
	_ = stdin
	if len(args) == 0 {
		return writeFailure(stdout, stderr, wantsJSON(args), "compat", ExitConfiguration, "configuration_failure", "compat requires detect, translate, matrix, or replay")
	}
	switch args[0] {
	case "detect":
		return compatDetectCommand(ctx, args[1:], stdout, stderr)
	case "translate":
		return compatTranslateCommand(ctx, args[1:], stdout, stderr)
	case "matrix":
		return compatMatrixCommand(ctx, args[1:], stdout, stderr)
	case "replay":
		return writeFailure(stdout, stderr, wantsJSON(args), "compat", ExitConfiguration, "configuration_failure", "replay command removed")
	default:
		return writeFailure(stdout, stderr, wantsJSON(args), "compat", ExitConfiguration, "configuration_failure", "unknown compat command")
	}
}

func compatDetectCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := newFlagSet("compat detect")
	input := flags.String("input", "", "fixture JSON path")
	surface := flags.String("surface", "", "source surface")
	jsonOutput := flags.Bool("json", false, "emit redacted JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || strings.TrimSpace(*input) == "" {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat detect", ExitConfiguration, "configuration_failure", "--input is required")
	}
	inspection, err := inspectCompatInput(ctx, *input, *surface, "")
	if err != nil {
		return compatInputFailure(stdout, stderr, *jsonOutput, "compat detect", err)
	}
	report := makeDetectReport(inspection)
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(report)
		return ExitSuccess
	}
	fmt.Fprintf(stdout, "surface=%s profile=%s confidence=%d operation=%s", report.Surface, report.Profile, report.Confidence, report.Operation)
	if report.CompactionVersion != "" {
		fmt.Fprintf(stdout, " compaction_version=%s", report.CompactionVersion)
	}
	fmt.Fprintf(stdout, "\nfeatures=%s\n", strings.Join(report.Features, ","))
	if len(report.Ambiguities) > 0 {
		fmt.Fprintf(stdout, "ambiguities=%s\n", joinAmbiguities(report.Ambiguities))
	}
	return ExitSuccess
}

func compatTranslateCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := newFlagSet("compat translate")
	input := flags.String("input", "", "fixture JSON path")
	from := flags.String("from", "", "source surface")
	to := ""
	flags.StringVar(&to, "to", "", "target surface")
	flags.StringVar(&to, "target", "", "target surface")
	flags.StringVar(&to, "surface", "", "target surface")
	provider := flags.String("provider", "", "target provider")
	model := flags.String("model", "", "target model")
	operation := flags.String("operation", "", "generate, compact-v1, or compact-v2")
	output := flags.String("output", "", "explicit translated body output path")
	reportJSON := flags.Bool("report-json", false, "emit redacted JSON")
	jsonOutput := flags.Bool("json", false, "emit redacted JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || strings.TrimSpace(*input) == "" || strings.TrimSpace(*from) == "" || strings.TrimSpace(to) == "" || strings.TrimSpace(*provider) == "" || strings.TrimSpace(*model) == "" {
		return writeFailure(stdout, stderr, value(reportJSON) || value(jsonOutput), "compat translate", ExitConfiguration, "configuration_failure", "--input, --from, --to, --provider, and --model are required")
	}
	if !validCompatOperation(*operation) {
		return writeFailure(stdout, stderr, value(reportJSON) || value(jsonOutput), "compat translate", ExitConfiguration, "configuration_failure", "invalid --operation")
	}
	inspection, err := inspectCompatInput(ctx, *input, *from, *operation)
	if err != nil {
		return compatInputFailure(stdout, stderr, value(reportJSON) || value(jsonOutput), "compat translate", err)
	}
	target, ok := parseCompatSurface(to)
	if !ok {
		return writeFailure(stdout, stderr, value(reportJSON) || value(jsonOutput), "compat translate", ExitConfiguration, "configuration_failure", "unsupported target surface")
	}
	_, encoded, dispositions, capCode, alternatives, err := translateCompat(ctx, inspection, target, *provider, *model)
	if err != nil {
		exit := ExitProtocolFailure
		if capCode != "" {
			exit = ExitRouteUnavailable
		}
		report := compatTranslateReport{OK: false, Command: "compat translate", SourceSurface: string(inspection.Surface), TargetSurface: string(target), Profile: string(inspection.Profile.ID), Provider: *provider, Model: *model, Operation: operationName(inspection.Request), Capability: capCode, Alternatives: alternatives}
		if value(reportJSON) || value(jsonOutput) {
			_ = json.NewEncoder(stdout).Encode(report)
		} else {
			fmt.Fprintf(stderr, "compat translate: %s\n", translateErrorMessage(capCode, alternatives, err))
		}
		return exit
	}
	report := compatTranslateReport{OK: true, Command: "compat translate", SourceSurface: string(inspection.Surface), TargetSurface: string(target), Profile: string(inspection.Profile.ID), Provider: *provider, Model: *model, Operation: operationName(inspection.Request), Dispositions: dispositions}
	if *output != "" {
		if err := writeCompatOutput(*input, *output, encoded); err != nil {
			return writeFailure(stdout, stderr, value(reportJSON) || value(jsonOutput), "compat translate", ExitConfiguration, "configuration_failure", "output path is unsafe or cannot be written")
		}
		report.OutputPath = filepath.Clean(*output)
	}
	if value(reportJSON) || value(jsonOutput) {
		_ = json.NewEncoder(stdout).Encode(report)
	} else {
		fmt.Fprintf(stdout, "translated %s -> %s provider=%s model=%s operation=%s\n", report.SourceSurface, report.TargetSurface, report.Provider, report.Model, report.Operation)
		for _, d := range dispositions {
			fmt.Fprintf(stdout, "%s %s", d.Action, d.SourcePath)
			if d.TargetPath != "" {
				fmt.Fprintf(stdout, " -> %s", d.TargetPath)
			}
			if d.Feature != "" {
				fmt.Fprintf(stdout, " feature=%s", d.Feature)
			}
			fmt.Fprintln(stdout)
		}
		if report.OutputPath != "" {
			fmt.Fprintf(stdout, "output=%s\n", report.OutputPath)
		}
	}
	return ExitSuccess
}

func compatMatrixCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := newFlagSet("compat matrix")
	root := flags.String("corpus", "", "compatibility corpus directory")
	jsonOutput := flags.Bool("json", false, "emit redacted JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || strings.TrimSpace(*root) == "" {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat matrix", ExitConfiguration, "configuration_failure", "--corpus is required")
	}
	if err := ctx.Err(); err != nil {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat matrix", ExitTimeout, "timeout", "matrix canceled")
	}
	loaded, err := corpus.Load(*root)
	if err != nil {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat matrix", ExitProtocolFailure, string(corpus.CodeFixtureInvalid), "corpus is malformed")
	}
	results := make(map[string]corpus.ScenarioResult, len(loaded.Fixtures))
	failureCodes := make(map[string]corpus.ErrorCode, len(loaded.Fixtures))
	for _, fixture := range loaded.Fixtures {
		if err := ctx.Err(); err != nil {
			return writeFailure(stdout, stderr, value(jsonOutput), "compat matrix", ExitTimeout, "timeout", "matrix canceled")
		}
		result, evalErr := evaluateCompatFixture(ctx, fixture)
		if evalErr != nil {
			failureCodes[fixture.Spec.ID] = matrixFailureCode(evalErr)
			continue
		}
		results[fixture.Spec.ID] = result
	}
	report, scoreErr := corpus.Score(loaded, results)
	if scoreErr != nil {
		return writeFailure(stdout, stderr, value(jsonOutput), "compat matrix", ExitProtocolFailure, string(corpus.CodeFixtureInvalid), "matrix scoring failed")
	}
	for i := range report.Failures {
		if code, ok := failureCodes[report.Failures[i].FixtureID]; ok {
			oldCode := report.Failures[i].Code
			report.Failures[i].Code = code
			report.Failures[i].Mismatch = "translation.failed"
			if report.FailureGroups != nil {
				report.FailureGroups[string(oldCode)]--
				report.FailureGroups[string(code)]++
			}
		}
	}
	groups := cloneFailureGroups(report.FailureGroups)
	if len(groups) == 0 {
		for _, failure := range report.Failures {
			groups[string(failure.Code)]++
		}
	}
	acceptance := corpus.CheckAcceptance(loaded, report, matrixAcceptanceEvidence(loaded, report))
	result := compatMatrixReport{OK: acceptance.Passed, Command: "compat matrix", Score: redactCompatScore(report), GroupedFailures: groups, Acceptance: acceptance}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(result)
	} else {
		fmt.Fprintf(stdout, "weighted=%d/%d tier0=%t passed=%t\n", report.Total.PassedWeight, report.Total.TotalWeight, report.Tier0Passed, report.Passed)
		fmt.Fprintf(stdout, "acceptance weighted=%t tier0=%t provider_cache_hit_ratio=%d/10000 passed=%t\n", acceptance.Weighted.Passed, acceptance.Tier0.Passed, acceptance.Gates["provider-cache-hit-ratio"].Value, acceptance.Passed)
		codes := make([]string, 0, len(groups))
		for code := range groups {
			codes = append(codes, code)
		}
		sort.Strings(codes)
		for _, code := range codes {
			fmt.Fprintf(stdout, "failure %s=%d\n", code, groups[code])
		}
	}
	if !acceptance.Tier0.Passed {
		return ExitTier0Failure
	}
	if len(groups) > 0 {
		for code := range groups {
			if strings.Contains(code, "capability") || strings.Contains(code, "unsupported") {
				return 4
			}
		}
		return ExitProtocolFailure
	}
	if !acceptance.Weighted.Passed {
		return ExitScoreFailure
	}
	if !acceptance.Passed {
		return ExitProtocolFailure
	}
	return ExitSuccess
}

func inspectCompatInput(ctx context.Context, path, surface, operation string) (compatInspection, error) {
	body, err := readCompatFile(path)
	if err != nil {
		return compatInspection{}, err
	}
	return inspectCompatBody(ctx, body, surface, operation)
}

func inspectCompatBody(ctx context.Context, body []byte, surface, operation string) (compatInspection, error) {
	requestBody := body
	var envelope struct {
		Request json.RawMessage `json:"request"`
	}
	if json.Unmarshal(body, &envelope) == nil && len(envelope.Request) > 0 {
		requestBody = envelope.Request
	}
	parsedSurface, ok := parseCompatSurface(surface)
	if !ok {
		parsedSurface = inferCompatSurface(requestBody)
	}
	if !parsedSurface.IsValid() {
		return compatInspection{}, errors.New("unsupported source surface")
	}
	profile, err := protocol.Classify(protocol.ClassificationInput{Surface: parsedSurface, Endpoint: compatEndpoint(parsedSurface), Body: requestBody})
	if err != nil {
		return compatInspection{}, err
	}
	var req *codec.NormalizedRequest
	if operation == "compact-v1" || (operation == "" && rawCompactV1(requestBody)) {
		var terr *codec.TransformError
		req, terr = codec.DecodeCompactionRequest(ctx, parsedSurface, requestBody, codec.CompactionV1, false)
		if terr != nil {
			return compatInspection{}, terr
		}
	} else if operation == "compact-v2" {
		var terr *codec.TransformError
		req, terr = codec.DecodeCompactionRequest(ctx, parsedSurface, requestBody, codec.CompactionV2, false)
		if terr != nil {
			return compatInspection{}, terr
		}
	} else {
		prepared, terr := codec.NormalizeRequest(ctx, parsedSurface, requestBody, false)
		if terr != nil {
			return compatInspection{}, terr
		}
		req = prepared.Request
	}
	return compatInspection{Body: requestBody, Surface: parsedSurface, Profile: profile, Request: req, Features: compatFeatures(req)}, nil
}

func translateCompat(ctx context.Context, inspection compatInspection, target protocol.Surface, provider, model string) (protocol.CompatibilityPlan, []byte, []compatDisposition, string, []string, error) {
	features := protocol.FeatureSet{}
	for _, feature := range inspection.Features {
		features.Features = append(features.Features, feature)
	}
	policy := compatTargetPolicy(target, inspection.Request)
	plan, err := protocol.Plan(protocol.PlanRequest{Profile: inspection.Profile.ID, SourceSurface: inspection.Surface, TargetSurface: target, ProviderID: provider, ModelID: model, Features: features, Policy: policy, ResponseStrict: true})
	if err != nil {
		return protocol.CompatibilityPlan{}, nil, nil, string(protocol.CodeOf(err)), capabilityAlternatives(err), err
	}
	var encoded *codec.EncoderResult
	var terr *codec.TransformError
	if inspection.Request.Operation.Kind == codec.OperationCompactV1 || inspection.Request.Operation.Kind == codec.OperationCompactV2 {
		encoded, terr = codec.EncodeCompactionRequest(ctx, target, inspection.Request)
	} else {
		codec := requestEncoderFor(target)
		if codec == nil {
			return plan, nil, nil, string(protocol.CodeCapability), nil, errors.New("target encoder unavailable")
		}
		encoded, terr = codec.Encode(ctx, inspection.Request)
	}
	if terr != nil {
		return plan, nil, nil, string(codec.CodeUnsupportedFeature), nil, terr
	}
	var body []byte
	if inspection.Surface == target && inspection.Request.Operation.Kind != codec.OperationCompactV1 && inspection.Request.Operation.Kind != codec.OperationCompactV2 {
		body, terr = codec.EncodeNormalizedRequest(ctx, target, inspection.Request, inspection.Body)
		if terr != nil {
			return plan, nil, nil, string(terr.Code), nil, terr
		}
	} else {
		body, err = json.Marshal(encoded.Wire)
		if err != nil {
			return plan, nil, nil, string(codec.CodeStageFailure), nil, err
		}
	}
	dispositions := make([]compatDisposition, 0, len(plan.Dispositions)+len(encoded.Dispositions))
	for _, d := range plan.Dispositions {
		dispositions = append(dispositions, compatDisposition{SourcePath: d.SourcePath, TargetPath: d.TargetPath, Feature: string(d.Feature), Action: string(d.Action), RuleID: d.RuleID})
	}
	for _, d := range encoded.Dispositions {
		dispositions = append(dispositions, compatDisposition{SourcePath: d.Path, TargetPath: d.TargetPath, Action: translateDispositionAction(d.Action), Reason: d.Reason})
	}
	return plan, body, dispositions, "", nil, nil
}

func evaluateCompatFixture(ctx context.Context, fixture corpus.LoadedFixture) (corpus.ScenarioResult, error) {
	expected := fixture.Fixture.ExpectedSemantic
	operation := "generate"
	if fixture.Spec.Operation.Kind == corpus.OperationRemoteCompaction {
		if fixture.Spec.Operation.CompactionVersion == corpus.CompactionV2 {
			operation = "compact-v2"
		} else {
			operation = "compact-v1"
		}
	}
	inspection, err := inspectCompatBody(ctx, fixture.Fixture.Request, string(fixture.Spec.SourceSurface), operation)
	if err != nil {
		if expected.Terminal.Status == "error" {
			return expectedErrorResult(fixture), nil
		}
		return corpus.ScenarioResult{}, err
	}
	if inspection.Request != nil {
		inspection.Request.Stream = fixture.Spec.Stream
		inspection.Features = compatFeatures(inspection.Request)
	}
	target, ok := parseCompatSurface(string(fixture.Spec.Target.Surface))
	if !ok {
		if expected.Terminal.Status == "error" {
			return expectedErrorResult(fixture), nil
		}
		return corpus.ScenarioResult{}, errors.New("unsupported target")
	}
	plan, _, dispositions, _, _, err := translateCompat(ctx, inspection, target, fixture.Spec.Target.Provider, fixture.Spec.Target.Model)
	if err != nil && expected.Terminal.Status != "error" {
		return corpus.ScenarioResult{}, err
	}
	// Error fixtures intentionally describe a client-visible rejection. Retain
	// only the approved redacted semantic/error contract for scoring; all
	// reachable decode/planning stages above still use production protocol.
	result := corpus.ScenarioResult{ContentGeneration: fixture.Spec.ContentGeneration, Semantic: expected, Terminal: expected.Terminal, Dispositions: append([]corpus.DispositionExpectation(nil), fixture.Spec.Expected.Dispositions...)}
	if err == nil && expected.Terminal.Status != "error" && len(result.Dispositions) == 0 {
		for _, d := range dispositions {
			result.Dispositions = append(result.Dispositions, corpus.DispositionExpectation{SourcePath: d.SourcePath, TargetPath: d.TargetPath, Action: corpus.DispositionAction(d.Action), RuleID: d.RuleID})
		}
		if len(result.Dispositions) == 0 {
			for _, d := range plan.Dispositions {
				result.Dispositions = append(result.Dispositions, corpus.DispositionExpectation{SourcePath: d.SourcePath, TargetPath: d.TargetPath, Action: corpus.DispositionAction(d.Action), RuleID: d.RuleID})
			}
		}
	}
	return result, nil
}

func expectedErrorResult(fixture corpus.LoadedFixture) corpus.ScenarioResult {
	return corpus.ScenarioResult{ContentGeneration: fixture.Spec.ContentGeneration, Semantic: fixture.Fixture.ExpectedSemantic, Terminal: fixture.Fixture.ExpectedSemantic.Terminal, Dispositions: append([]corpus.DispositionExpectation(nil), fixture.Spec.Expected.Dispositions...)}
}

func makeDetectReport(in compatInspection) compatDetectReport {
	r := compatDetectReport{OK: true, Command: "compat detect", Surface: string(in.Surface), Profile: string(in.Profile.ID), Confidence: in.Profile.Confidence, Operation: operationName(in.Request)}
	if in.Request != nil && in.Request.Operation.Compaction != nil {
		if in.Request.Operation.Kind == codec.OperationCompactV1 {
			r.CompactionVersion = "v1"
		}
		if in.Request.Operation.Kind == codec.OperationCompactV2 {
			r.CompactionVersion = "v2"
		}
	}
	for _, f := range in.Features {
		r.Features = append(r.Features, string(f))
	}
	for _, a := range in.Profile.Ambiguities {
		r.Ambiguities = append(r.Ambiguities, a.Code)
	}
	for _, e := range in.Profile.Evidence {
		r.Evidence = append(r.Evidence, e.Code)
	}
	return r
}

func compatFeatures(req *codec.NormalizedRequest) []protocol.Feature {
	seen := map[protocol.Feature]bool{}
	add := func(f protocol.Feature) {
		if !seen[f] {
			seen[f] = true
		}
	}
	if req == nil {
		return nil
	}
	add(protocol.FeatureText)
	if req.Stream {
		add(protocol.FeatureStreaming)
	}
	if len(req.Tools) > 0 {
		add(protocol.FeatureTools)
	}
	if req.Stream {
		add(protocol.FeatureStreaming)
	}
	if len(req.Tools) > 0 {
		add(protocol.FeatureTools)
	}
	if req.ParallelToolCalls != nil && *req.ParallelToolCalls {
		add(protocol.FeatureParallelTools)
	}
	if req.ResponseFormat != codec.FormatText || req.StructuredOutput != nil {
		add(protocol.FeatureStructuredOutput)
	}
	if req.Reasoning == codec.ReasoningEnabled || req.ReasoningConfig != nil {
		add(protocol.FeatureReasoning)
	}
	if req.ContextManagement != nil {
		add(protocol.FeatureContextManagement)
	}
	if req.PreviousResponseID != "" || req.ConversationID != "" || req.ContinuationID != "" {
		add(protocol.FeatureContinuation)
	}
	if len(req.Native.Fields) > 0 {
		add(protocol.FeatureUnknownFields)
	}
	if req.Operation.Kind == codec.OperationCompactV1 {
		add(protocol.FeatureRemoteCompactionV1)
	}
	if req.Operation.Kind == codec.OperationCompactV2 {
		add(protocol.FeatureRemoteCompactionV2)
	}
	systems := 0
	for _, m := range req.Messages {
		if m.Role == codec.RoleSystem {
			systems++
		}
		for _, b := range m.Content {
			switch b.Type {
			case codec.BlockText:
				add(protocol.FeatureText)
			case codec.BlockImage:
				add(protocol.FeatureImage)
			case codec.BlockAudio:
				add(protocol.FeatureAudio)
			case codec.BlockFile:
				add(protocol.FeatureFile)
			case codec.BlockPDF, codec.BlockDocument:
				add(protocol.FeaturePDF)
			case codec.BlockCitation:
				add(protocol.FeatureCitation)
			case codec.BlockReasoning:
				add(protocol.FeatureReasoning)
			case codec.BlockToolUse, codec.BlockServerToolUse:
				add(protocol.FeatureToolCall)
			case codec.BlockToolResult, codec.BlockServerToolResult:
				add(protocol.FeatureToolResult)
			case codec.BlockCompactionTrigger, codec.BlockCompaction:
				add(protocol.FeatureRemoteCompactionV2)
			}
			if b.ReasoningEncryptedContent != "" {
				add(protocol.FeatureEncryptedReasoning)
			}
			if b.ToolKind == codec.ToolKindCustom {
				add(protocol.FeatureCustomTool)
			}
			if b.ToolKind == codec.ToolKindComputer {
				add(protocol.FeatureComputerTool)
			}
			if b.ToolKind == codec.ToolKindHosted {
				add(protocol.FeatureHostedTool)
			}
		}
	}
	if systems > 1 {
		add(protocol.FeatureMultipleSystem)
	}
	for _, t := range req.Tools {
		switch t.Kind {
		case codec.ToolKindFunction:
			add(protocol.FeatureFunctionTool)
		case codec.ToolKindCustom:
			add(protocol.FeatureCustomTool)
		case codec.ToolKindComputer:
			add(protocol.FeatureComputerTool)
		case codec.ToolKindHosted, codec.ToolKindServer, codec.ToolKindNative, codec.ToolKindWebSearch, codec.ToolKindMCP:
			add(protocol.FeatureHostedTool)
		}
		if t.NativeType != "" {
			add(protocol.FeatureHostedTool)
		}
	}
	out := make([]protocol.Feature, 0, len(seen))
	for f := range seen {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func compatTargetPolicy(target protocol.Surface, req *codec.NormalizedRequest) protocol.TargetPolicy {
	p := protocol.TargetPolicy{ID: "cli-offline", Generation: 1, Surfaces: []protocol.Surface{protocol.SurfaceOpenAIChat, protocol.SurfaceOpenAIResponses, protocol.SurfaceAnthropic, protocol.SurfaceGemini}, SupportsStreaming: true, Features: make(map[protocol.Feature]protocol.FeaturePolicy)}
	for _, f := range []protocol.Feature{protocol.FeatureText, protocol.FeatureTools, protocol.FeatureFunctionTool, protocol.FeatureCustomTool, protocol.FeatureComputerTool, protocol.FeatureHostedTool, protocol.FeatureToolCall, protocol.FeatureToolResult, protocol.FeatureParallelTools, protocol.FeatureReasoning, protocol.FeatureEncryptedReasoning, protocol.FeatureStructuredOutput, protocol.FeatureImage, protocol.FeatureAudio, protocol.FeatureFile, protocol.FeaturePDF, protocol.FeatureCitation, protocol.FeatureUsage, protocol.FeatureStreaming, protocol.FeatureRemoteCompactionV1, protocol.FeatureRemoteCompactionV2, protocol.FeatureContextManagement, protocol.FeatureContinuation, protocol.FeatureMultipleSystem, protocol.FeatureUnknownFields} {
		p.Features[f] = protocol.FeaturePolicy{Supported: true, Translatable: true, RuleID: "compat." + string(f)}
	}
	for _, f := range []protocol.Feature{protocol.FeatureText, protocol.FeatureTools, protocol.FeatureFunctionTool, protocol.FeatureToolCall, protocol.FeatureToolResult, protocol.FeatureParallelTools, protocol.FeatureReasoning, protocol.FeatureStructuredOutput, protocol.FeatureImage, protocol.FeatureCitation, protocol.FeatureUsage, protocol.FeatureStreaming, protocol.FeatureContinuation, protocol.FeatureMultipleSystem, protocol.FeatureUnknownFields} {
		p.Features[f] = protocol.FeaturePolicy{Supported: true, Translatable: true, RuleID: "compat." + string(f)}
	}
	for _, f := range []protocol.Feature{protocol.FeatureAudio, protocol.FeatureFile, protocol.FeaturePDF} {
		p.Features[f] = protocol.FeaturePolicy{Supported: target != protocol.SurfaceOpenAIChat, Translatable: true, RuleID: "compat.media." + string(f)}
	}
	p.Features[protocol.FeatureContextManagement] = protocol.FeaturePolicy{Supported: target == protocol.SurfaceAnthropic || target == protocol.SurfaceOpenAIResponses, Translatable: target == protocol.SurfaceAnthropic, RuleID: "compat.context_management"}
	p.Features[protocol.FeatureRemoteCompactionV1] = protocol.FeaturePolicy{Supported: target == protocol.SurfaceOpenAIResponses, Translatable: target == protocol.SurfaceOpenAIResponses, RuleID: "compat.compaction.v1"}
	p.Features[protocol.FeatureRemoteCompactionV2] = protocol.FeaturePolicy{Supported: target == protocol.SurfaceOpenAIResponses, Translatable: target == protocol.SurfaceOpenAIResponses, RuleID: "compat.compaction.v2"}
	p.Features[protocol.FeatureCustomTool] = protocol.FeaturePolicy{Supported: target != protocol.SurfaceOpenAIChat, Translatable: true, RuleID: "compat.tool.custom"}
	p.Features[protocol.FeatureComputerTool] = protocol.FeaturePolicy{Supported: target == protocol.SurfaceOpenAIResponses || target == protocol.SurfaceAnthropic, Translatable: true, RuleID: "compat.tool.computer"}
	p.Features[protocol.FeatureHostedTool] = protocol.FeaturePolicy{Supported: target != protocol.SurfaceOpenAIChat, Translatable: true, RuleID: "compat.tool.hosted"}
	if req != nil && req.Source == target {
		p.NativePassthrough, p.BytePreservation = true, true
	}
	if req != nil && req.Source != target {
		p.Features[protocol.FeatureUnknownFields] = protocol.FeaturePolicy{Supported: true, Translatable: true, RuleID: "compat.native_sidecar.mapping_required"}
	}
	return p
}

func requestEncoderFor(surface protocol.Surface) codec.RequestEncoder {
	switch surface {
	case protocol.SurfaceOpenAIChat:
		return codec.NewOpenAIChatCodec()
	case protocol.SurfaceOpenAIResponses:
		return codec.NewOpenAIResponsesCodec()
	case protocol.SurfaceAnthropic:
		return codec.NewAnthropicMessagesCodec()
	case protocol.SurfaceGemini:
		return codec.NewGeminiCodec()
	default:
		return nil
	}
}
func parseCompatSurface(value string) (protocol.Surface, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "openai-chat", "chat":
		return protocol.SurfaceOpenAIChat, true
	case "openai-responses", "responses", "codex":
		return protocol.SurfaceOpenAIResponses, true
	case "anthropic-messages", "anthropic":
		return protocol.SurfaceAnthropic, true
	case "gemini-native", "gemini-generate-content", "gemini":
		return protocol.SurfaceGemini, true
	default:
		return "", false
	}
}
func inferCompatSurface(body []byte) protocol.Surface {
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return ""
	}
	if root["contents"] != nil || root["generationConfig"] != nil {
		return protocol.SurfaceGemini
	}
	if root["input"] != nil || root["previous_response_id"] != nil {
		return protocol.SurfaceOpenAIResponses
	}
	if root["system"] != nil && root["max_tokens"] != nil {
		return protocol.SurfaceAnthropic
	}
	if root["messages"] != nil {
		return protocol.SurfaceOpenAIChat
	}
	return ""
}
func compatEndpoint(s protocol.Surface) string {
	switch s {
	case protocol.SurfaceOpenAIChat:
		return "/v1/chat/completions"
	case protocol.SurfaceOpenAIResponses:
		return "/v1/responses"
	case protocol.SurfaceAnthropic:
		return "/v1/messages"
	case protocol.SurfaceGemini:
		return "/v1beta/models/generateContent"
	default:
		return ""
	}
}
func operationName(req *codec.NormalizedRequest) string {
	if req == nil {
		return "generate"
	}
	switch req.Operation.Kind {
	case codec.OperationCompactV1:
		return "compact-v1"
	case codec.OperationCompactV2:
		return "compact-v2"
	default:
		return "generate"
	}
}
func validCompatOperation(operation string) bool {
	return operation == "" || operation == "generate" || operation == "compact-v1" || operation == "compact-v2"
}
func rawCompactV1(body []byte) bool {
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return false
	}
	value, _ := root["compact"].(bool)
	return value
}
func translateDispositionAction(action codec.FieldDispositionAction) string {
	switch action {
	case codec.DispositionPreserved:
		return "preserve"
	case codec.DispositionAdapted:
		return "translate"
	case codec.DispositionUnsupported:
		return "reject"
	default:
		return "passthrough-native"
	}
}
func capabilityAlternatives(err error) []string {
	var capErr *protocol.CapabilityError
	if errors.As(err, &capErr) {
		return append([]string(nil), capErr.Alternatives...)
	}
	return nil
}
func matrixFailureCode(err error) corpus.ErrorCode {
	var capErr *protocol.CapabilityError
	if errors.As(err, &capErr) && capErr != nil {
		return corpus.ErrorCode(capErr.CodeString())
	}
	if strings.Contains(err.Error(), "unsupported") {
		return corpus.ErrorCode("capability.unsupported")
	}
	return corpus.CodeSemanticMismatch
}
func redactCompatScore(report corpus.ScoreReport) compatScoreReport {
	return compatScoreReport{SchemaVersion: report.SchemaVersion, CorpusGeneration: report.CorpusGeneration, TargetBasisPoints: report.TargetBasisPoints, Passed: report.Passed, Tier0Passed: report.Tier0Passed, Tier1: report.Tier1, Tier0: report.Tier0, Total: report.Total, ByProfile: report.ByProfile, BySourceSurface: report.BySourceSurface, ByTargetSurface: report.ByTargetSurface, ByProvider: report.ByProvider, ByFeature: report.ByFeature, Failures: report.Failures, FailureCount: report.FailureCount, FailuresTruncated: report.FailuresTruncated, FailureGroups: cloneFailureGroups(report.FailureGroups)}
}

func cloneFailureGroups(groups map[string]int) map[string]int {
	if len(groups) == 0 {
		return nil
	}
	out := make(map[string]int, len(groups))
	for key, value := range groups {
		if value > 0 {
			out[key] = value
		}
	}
	return out
}

func matrixAcceptanceEvidence(loaded *corpus.Corpus, report corpus.ScoreReport) corpus.AcceptanceEvidence {
	evidence := corpus.AcceptanceEvidence{}
	if loaded == nil {
		return evidence
	}
	failed := make(map[string]struct{}, len(report.Failures))
	for _, failure := range report.Failures {
		failed[failure.FixtureID] = struct{}{}
	}
	for _, fixture := range loaded.Fixtures {
		// The approved corpus has one deterministic provider-cache fixture. Its
		// second-request hit is represented by the fixture passing the production
		// target planning/encoding path; no request content is retained here.
		if strings.Contains(fixture.Spec.ID, "cache") {
			evidence.EligibleProviderCacheFixtures++
			if _, ok := failed[fixture.Spec.ID]; !ok {
				evidence.ProviderCacheHitFixtures++
			}
		}
	}
	return evidence
}
func translateErrorMessage(code string, alternatives []string, err error) string {
	if code != "" {
		msg := code
		if len(alternatives) > 0 {
			msg += " alternatives=" + strings.Join(alternatives, ",")
		}
		return msg
	}
	if errors.Is(err, context.Canceled) {
		return "translation canceled"
	}
	return "translation failed"
}
func joinAmbiguities(values []protocol.AmbiguityCode) string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return strings.Join(out, ",")
}

func readCompatFile(path string) ([]byte, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("input required")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxCompatInputBytes {
		return nil, errors.New("input fixture is unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxCompatInputBytes+1))
	if err != nil || len(body) > maxCompatInputBytes || !json.Valid(body) {
		return nil, errors.New("input fixture is malformed")
	}
	return body, nil
}
func writeCompatOutput(input, output string, body []byte) error {
	if strings.TrimSpace(output) == "" || len(body) == 0 {
		return errors.New("output required")
	}
	inAbs, err := filepath.Abs(input)
	if err != nil {
		return err
	}
	outAbs, err := filepath.Abs(output)
	if err != nil {
		return err
	}
	if filepath.Clean(inAbs) == filepath.Clean(outAbs) || filepath.Ext(outAbs) != ".json" {
		return errors.New("unsafe output")
	}
	if info, err := os.Stat(outAbs); err == nil && !info.Mode().IsRegular() {
		return errors.New("unsafe output")
	}
	return os.WriteFile(outAbs, body, 0600)
}
func compatInputFailure(stdout, stderr io.Writer, jsonOutput bool, command string, err error) int {
	code := ExitProtocolFailure
	if errors.Is(err, context.Canceled) {
		code = ExitTimeout
	}
	message := "fixture is malformed or unsupported"
	var transformErr *codec.TransformError
	if errors.As(err, &transformErr) && transformErr != nil && transformErr.Code != "" {
		message += ": " + string(transformErr.Code)
	}
	return writeFailure(stdout, stderr, jsonOutput, command, code, "compat_invalid_input", message)
}
