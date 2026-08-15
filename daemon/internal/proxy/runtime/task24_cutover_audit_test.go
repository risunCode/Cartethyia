package proxy

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/control/cacheplan"
	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

type task24Authority struct {
	Name     string
	Owner    string
	Subowner string
}

// TestTask24OwnerSubownerAuthorityAudit is intentionally narrow: it records the
// single active authority for each compatibility decision and rejects accidental
// second registries during future cutovers. It does not execute a provider.
func TestTask24OwnerSubownerAuthorityAudit(t *testing.T) {
	authorities := []task24Authority{
		{Name: "client-classifier", Owner: "protocol/compatibility", Subowner: "compatibility.Classify"},
		{Name: "compatibility-planner", Owner: "protocol/compatibility", Subowner: "compatibility.Plan"},
		{Name: "request-codecs", Owner: "protocol/transforms", Subowner: "transforms.Registry"},
		{Name: "response-codecs", Owner: "protocol/transforms", Subowner: "transforms.Registry"},
		{Name: "candidate-preparer", Owner: "proxy/runtime", Subowner: "runtime.CandidatePreparer"},
		{Name: "router", Owner: "proxy/runtime", Subowner: "runtime.Router"},
		{Name: "account-pool", Owner: "proxy/runtime", Subowner: "runtime.AccountPool"},
		{Name: "provider-cache-planner", Owner: "proxy/control/cacheplan", Subowner: "cacheplan.PlanFinalWire"},
		{Name: "evidence-registry", Owner: "observability", Subowner: "observability.Registry"},
	}
	seen := make(map[string]struct{}, len(authorities))
	for _, authority := range authorities {
		if authority.Name == "" || authority.Owner == "" || authority.Subowner == "" {
			t.Fatalf("incomplete authority entry: %#v", authority)
		}
		if _, exists := seen[authority.Name]; exists {
			t.Fatalf("duplicate authority: %s", authority.Name)
		}
		seen[authority.Name] = struct{}{}
	}
	if len(seen) != 9 {
		t.Fatalf("authority count = %d, want 9", len(seen))
	}

	codes := []string{
		string(compatibility.CodeInvalidPlan),
		string(compatibility.CodeCapability),
		string(compatibility.CodeToolKindUnsupported),
		string(compatibility.CodeMediaUnsupported),
		string(compatibility.CodeDocumentUnsupported),
		string(compatibility.CodeCompactionV1Unsupported),
		string(compatibility.CodeCompactionV2Unsupported),
		string(compatibility.CodeCompactionBridgeUnsupported),
		string(cacheplan.CodeInvalidBoundary),
		string(cacheplan.CodeUnsupportedCapability),
		string(transforms.CodeNativeSidecarUnconsumed),
		string(transforms.CodeInvalidMediaReference),
		string(transforms.CodeInvalidCompaction),
	}
	for _, code := range codes {
		if strings.TrimSpace(code) == "" || !strings.Contains(code, ".") {
			t.Fatalf("unstable error code %q", code)
		}
	}
}

// TestTask24CleanCutoverVerification is a source-level guard for the final
// cutover. It is deliberately not invoked by the normal verification workflow;
// run it only when reviewing a clean-cutover change. The pre-prepare transport
// interface and no-codec StreamBridge constructor are documented compatibility
// shims until their remaining callers are migrated.
func TestTask24CleanCutoverVerification(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate cutover audit source")
	}
	daemonRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	forbiddenPaths := []string{
		filepath.Join(daemonRoot, "internal", "proxy", "proxy.go"),
		filepath.Join(daemonRoot, "internal", "proxy", "runtime", "openai_projection.go"),
	}
	for _, path := range forbiddenPaths {
		if _, err := os.Stat(path); err == nil {
			t.Fatalf("obsolete production path still exists: %s", path)
		} else if !os.IsNotExist(err) {
			t.Fatalf("stat obsolete path %s: %v", path, err)
		}
	}

	forbiddenSymbols := []string{
		"translate" + "ChatMessagesToResponses",
		"preserve" + "UnknownJSON",
		"merge" + "Unknown",
		"knownCanonical" + "JSONKey",
		"applyOpenAI" + "PromptCache",
		"applyGrok" + "PromptCacheIdentity",
	}
	sourceFiles := []string{
		filepath.Join(daemonRoot, "internal", "providers", "adapters", "openai.go"),
		filepath.Join(daemonRoot, "internal", "providers", "adapters", "grok.go"),
		filepath.Join(daemonRoot, "internal", "proxy", "protocol", "transforms", "prepare.go"),
		filepath.Join(daemonRoot, "internal", "proxy", "runtime", "response_projection.go"),
	}
	for _, path := range sourceFiles {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read cutover source %s: %v", path, err)
		}
		for _, symbol := range forbiddenSymbols {
			if strings.Contains(string(body), symbol) {
				t.Fatalf("obsolete symbol %q remains in %s", symbol, path)
			}
		}
	}
}
