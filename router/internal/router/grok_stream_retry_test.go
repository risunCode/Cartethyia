package router

import (
	"context"
	"sync"
	"testing"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

type grokPrecontentTransport struct {
	mu       sync.Mutex
	calls    int
	bodies   [][]byte
	repairer *adapters.GrokBuildAdapter
}

func (t *grokPrecontentTransport) CallStream(_ context.Context, _ Account, req contracts.Request) (*Stream, error) {
	t.mu.Lock()
	t.calls++
	t.bodies = append(t.bodies, append([]byte(nil), req.Body...))
	call := t.calls
	t.mu.Unlock()
	ch := make(chan StreamEvent, 2)
	if call == 1 {
		ch <- StreamEvent{Kind: EventMessageStop, Err: WithRepairRule(ErrInvalidEncryptedContent, adapters.GrokRepairInvalidEncryptedReasoning), Reason: "error"}
	} else {
		ch <- StreamEvent{Kind: EventTextDelta, Text: "ok"}
		ch <- StreamEvent{Kind: EventMessageStop}
	}
	close(ch)
	return NewStream(ch, nil, 0, 0), nil
}

func (t *grokPrecontentTransport) ProposeRepair(_ Account, req contracts.Request, ruleID string) (providers.RepairProposal, bool) {
	return t.repairer.ProposeRepair(ruleID, providers.RequestEnvelope{
		Target: providers.RouteTarget{ProviderID: "grok-build"}, Body: req.Body, Stream: true,
	})
}

func TestRouterRetriesGrokInvalidEncryptedContentBeforeCommit(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: failoverStore{accounts: []Account{{ID: "grok", Provider: "grok-build", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	transport := &grokPrecontentTransport{repairer: adapters.NewGrokBuildAdapter(adapters.GrokBuildConfig{ID: "grok-build"})}
	req := contracts.Request{
		Protocol: contracts.SurfaceOpenAIResponses,
		Model:    "grok",
		Body:     []byte(`{"input":[{"type":"reasoning","summary":[],"encrypted_content":"cipher"},{"type":"message","role":"user","content":"hi"}]}`),
	}
	plan := catalog.RoutePlan{
		RequestedModel: req.Model,
		Strategy:       catalog.RouteStrategySingle,
		Members: []catalog.RouteMember{{
			ProviderID:      "grok-build",
			ClientModelID:   req.Model,
			UpstreamModelID: req.Model,
			Surface:         req.Protocol,
		}},
	}
	stream, accountID, failure, err := router.RouteStream(context.Background(), transport, req, plan)
	if err != nil || failure != nil || stream == nil || accountID != "grok" {
		t.Fatalf("stream=%#v account=%q failure=%#v err=%v", stream, accountID, failure, err)
	}
	defer stream.Close()
	ev, nextErr := stream.Next(context.Background())
	if nextErr != nil || ev.Text != "ok" {
		t.Fatalf("event=%#v err=%v", ev, nextErr)
	}
	if transport.calls != 2 || len(transport.bodies) != 2 {
		t.Fatalf("calls=%d bodies=%d", transport.calls, len(transport.bodies))
	}
	if string(transport.bodies[0]) == string(transport.bodies[1]) {
		t.Fatal("encrypted-content retry did not alter request")
	}
	if string(transport.bodies[1]) == "" || containsBytes(transport.bodies[1], []byte("encrypted_content")) {
		t.Fatalf("retry body still contains encrypted content: %s", transport.bodies[1])
	}
}

func containsBytes(body, needle []byte) bool {
	for index := 0; index+len(needle) <= len(body); index++ {
		if string(body[index:index+len(needle)]) == string(needle) {
			return true
		}
	}
	return false
}
