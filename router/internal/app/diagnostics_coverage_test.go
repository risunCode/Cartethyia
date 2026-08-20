package app

import (
	"context"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestDoctorReportsFixtureAccountValidation(t *testing.T) {
	_, err := Doctor(context.Background(), Config{}.WithDefaults())
	if err == nil || !strings.Contains(err.Error(), "account references") {
		t.Fatalf("Doctor fixture validation = %v", err)
	}
}

func TestDoctorRejectsInvalidConfig(t *testing.T) {
	cfg := Config{RequestTimeout: -1}.WithDefaults()
	_, err := Doctor(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "config") {
		t.Fatalf("Doctor invalid config = %v", err)
	}
}

func TestExplainRouteRequiresModelAndSurface(t *testing.T) {
	cfg := Config{}.WithDefaults()
	_, err := ExplainRoute(context.Background(), cfg, "", contracts.SurfaceOpenAIChat)
	if err == nil || !strings.Contains(err.Error(), "model and valid surface") {
		t.Fatalf("ExplainRoute empty model = %v", err)
	}
	_, err = ExplainRoute(context.Background(), cfg, "gpt-4o-mini", contracts.Surface(""))
	if err == nil || !strings.Contains(err.Error(), "model and valid surface") {
		t.Fatalf("ExplainRoute invalid surface = %v", err)
	}
}

func TestExplainRouteReturnsPlanForKnownModel(t *testing.T) {
	cfg := Config{}.WithDefaults()
	explanation, err := ExplainRoute(context.Background(), cfg, "gpt-4o-mini", contracts.SurfaceOpenAIChat)
	if err != nil {
		t.Fatalf("ExplainRoute: %v", err)
	}
	if explanation.RequestedModel == "" || explanation.Surface == "" {
		t.Fatalf("empty explanation: %#v", explanation)
	}
}

func TestReadinessRequiresAccountSnapshot(t *testing.T) {
	_, err := Readiness(context.Background(), Config{}.WithDefaults(), "")
	if err == nil || !strings.Contains(err.Error(), "account snapshot") {
		t.Fatalf("Readiness fixture snapshot = %v", err)
	}
}

func TestBuildHandlerDevMode(t *testing.T) {
	handler, err := buildHandler(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	if handler == nil {
		t.Fatal("nil handler")
	}
}

func TestBuildHandlerWithArtwork(t *testing.T) {
	handler, err := buildHandlerWithArtwork(Config{}.WithDefaults(), "artwork-fixture")
	if err != nil {
		t.Fatalf("buildHandlerWithArtwork: %v", err)
	}
	if handler == nil {
		t.Fatal("nil handler")
	}
}
