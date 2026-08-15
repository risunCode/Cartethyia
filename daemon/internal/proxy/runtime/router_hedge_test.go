package proxy

import (
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
)

func TestHedgeEligibilityIsConservative(t *testing.T) {
	router := &Router{hedgeEnabled: true, maxHedges: 1, hedgeDelay: 10 * time.Millisecond}
	base := contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "gpt-5", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}
	plan := catalog.RoutePlan{Operation: catalog.OperationGenerate, Members: []catalog.RouteMember{{ProviderID: "openai", UpstreamModelID: "gpt-5"}, {ProviderID: "openai", UpstreamModelID: "gpt-5"}}}
	if !router.hedgeEligible(base, plan) {
		t.Fatal("ordinary idempotent request should be hedge eligible when explicitly enabled")
	}
	cases := []contracts.Request{
		{Protocol: contracts.SurfaceOpenAIChat, Model: "gpt-5", Stream: true, Body: base.Body},
		{Protocol: contracts.SurfaceOpenAIChat, Model: "gpt-5", Body: []byte(`{"tools":[{"type":"function"}]}`)},
		{Protocol: contracts.SurfaceOpenAIChat, Model: "gpt-5", Body: []byte(`{"previous_response_id":"resp_1"}`)},
		{Protocol: contracts.SurfaceOpenAIChat, Model: "gpt-5", Body: []byte(`{"store":true}`)},
	}
	for i, request := range cases {
		if router.hedgeEligible(request, plan) {
			t.Fatalf("case %d unexpectedly hedge eligible", i)
		}
	}
}
