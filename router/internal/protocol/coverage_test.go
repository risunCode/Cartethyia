package protocol

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestCompatibilityErrorsAndConstructors(t *testing.T) {
	var nilErr *Error
	if nilErr.Error() != "<nil compatibility error>" || nilErr.Unwrap() != nil || nilErr.CodeString() != "" {
		t.Fatal("nil compatibility error methods returned unexpected values")
	}
	e := &Error{Code: CodeInvalidInput, Field: "endpoint", Cause: errors.New("cause")}
	if e.Error() != "compat_invalid_input: field=endpoint" || e.Unwrap() == nil || !e.Is(&Error{Code: CodeInvalidInput}) {
		t.Fatal("compatibility error methods returned unexpected values")
	}
	if CodeOf(e) != CodeInvalidInput || CodeOf(errors.New("other")) != "" {
		t.Fatal("CodeOf returned unexpected code")
	}
	if _, err := NewClientProfile("bad", SurfaceOpenAIChat, 1, nil); CodeOf(err) != CodeInvalidProfile {
		t.Fatalf("NewClientProfile error = %v", err)
	}
	if _, err := NewEvidence("bad", false); CodeOf(err) != CodeInvalidEvidence {
		t.Fatalf("NewEvidence error = %v", err)
	}
	if _, err := NewAmbiguity("bad"); CodeOf(err) != CodeInvalidEvidence {
		t.Fatalf("NewAmbiguity error = %v", err)
	}
}

func TestProfileValidationAndContextHelpers(t *testing.T) {
	valid := ClientProfile{ID: ProfileCodexCLI, Surface: SurfaceOpenAIResponses, Confidence: 100}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid profile error = %v", err)
	}
	for _, invalid := range []ClientProfile{
		{ID: "bad", Surface: SurfaceOpenAIChat},
		{ID: ProfileCodexCLI, Surface: SurfaceOpenAIChat, Confidence: 101},
		{ID: ProfileCodexCLI, Surface: "bad"},
		{ID: ProfileCodexCLI, Surface: SurfaceOpenAIChat, Reasons: []string{"has space"}},
	} {
		if err := invalid.Validate(); err == nil {
			t.Fatalf("invalid profile %+v was accepted", invalid)
		}
	}
	ctx, err := WithProfile(context.Background(), valid)
	if err != nil {
		t.Fatalf("WithProfile() error = %v", err)
	}
	got, ok := ClientProfileFromContext(ctx)
	if !ok || got.ID != valid.ID {
		t.Fatalf("context profile = %+v, %v", got, ok)
	}
	if _, ok := ProfileFromContext(nil); ok {
		t.Fatal("nil context unexpectedly contained profile")
	}
	if _, err := WithProfile(nil, valid); CodeOf(err) != CodeContextInvalid {
		t.Fatalf("nil context error = %v", err)
	}
}

func TestClassificationAliasesAndHeaderHints(t *testing.T) {
	input := ClassificationInput{
		Endpoint: "/v1/chat/completions",
		Headers:  http.Header{"X-Client": []string{"cursor/1"}},
		Body:     []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
	}
	for name, classify := range map[string]func() (ClientProfile, error){
		"request": func() (ClientProfile, error) { return ClassifyRequest(input) },
		"profile": func() (ClientProfile, error) { return ClassifyClientProfile(input) },
		"surface": func() (ClientProfile, error) { return ClassifySurface("", input.Endpoint, input.Body, input.Headers) },
	} {
		profile, err := classify()
		if err != nil || profile.ID != ProfileOpenAICompatible {
			t.Fatalf("%s classification = %+v, %v", name, profile, err)
		}
	}
}

func TestClassificationRejectsInvalidAndUnavailableInputs(t *testing.T) {
	if _, err := Classify(ClassificationInput{Endpoint: strings.Repeat("x", MaxEndpointBytes+1)}); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("long endpoint error = %v", err)
	}
	if _, err := Classify(ClassificationInput{Surface: "bad"}); CodeOf(err) != CodeInvalidSurface {
		t.Fatalf("invalid surface error = %v", err)
	}
	profile, err := Classify(ClassificationInput{Endpoint: "/unknown", Body: []byte(`not-json`)})
	if err != nil || profile.ID != ProfileUnknownStandard || len(profile.Ambiguities) == 0 {
		t.Fatalf("unknown classification = %+v, %v", profile, err)
	}
}

func TestPlanCacheAndPlannerPaths(t *testing.T) {
	if _, err := NewPlanCache(nil, 1); CodeOf(err) != CodeInvalidPlan {
		t.Fatalf("nil cache error = %v", err)
	}
	backend := newPlanTestCache()
	cache, err := NewPlanCache(backend, 0)
	if err != nil || cache.ttlSeconds != DefaultPlanCacheTTL {
		t.Fatalf("default cache = %+v, %v", cache, err)
	}
	limited, err := NewPlanCache(backend, 99999)
	if err != nil || limited.ttlSeconds != 3600 {
		t.Fatalf("bounded cache = %+v, %v", limited, err)
	}
	req := planTestRequest()
	req.Features = FeatureSet{Features: []Feature{FeatureText}}
	ctx := context.Background()
	plan, err := PlanCached(ctx, backend, req)
	if err != nil {
		t.Fatalf("PlanCached() error = %v", err)
	}
	cached, err := limited.Plan(ctx, req)
	if err != nil || PlanDigest(cached) != PlanDigest(plan) {
		t.Fatalf("cached plan = %+v, %v", cached, err)
	}
	var nilPlanner *Planner
	if _, err := nilPlanner.Plan(nil, req); err != nil {
		t.Fatalf("nil planner fallback error = %v", err)
	}
	planner, err := NewPlanner(backend, 1)
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	if _, err := planner.Plan(nil, req); CodeOf(err) != CodeInvalidPlan {
		t.Fatalf("nil planner context error = %v", err)
	}
	var nilCache *PlanCache
	if _, err := nilCache.Plan(ctx, req); err != nil {
		t.Fatalf("nil cache fallback error = %v", err)
	}
}
