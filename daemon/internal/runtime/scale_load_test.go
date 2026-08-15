package runtime

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/config"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	proxy "github.com/cartethyia/daemon/internal/proxy/runtime"
)

// TestEndToEndTenKAccountCandidates exercises real HTTP ingress, routing,
// account selection, credential resolution, and an upstream HTTP stub with a
// 10,000-account directory. It is gated because it intentionally creates a
// large request/account workload; CI or a release operator runs it explicitly
// with CARTETHYIA_RUN_10K_LOAD=1.
func TestEndToEndTenKAccountCandidates(t *testing.T) {
	if os.Getenv("CARTETHYIA_RUN_10K_LOAD") != "1" {
		t.Skip("set CARTETHYIA_RUN_10K_LOAD=1 to run the 10k end-to-end profile")
	}
	const accountCount = 10000
	const requestCount = 10000
	const transientAccountCount = 64
	orderedAccountIDs := make([]string, accountCount)
	for index := range orderedAccountIDs {
		orderedAccountIDs[index] = "load-account-" + strconv.Itoa(index)
	}
	sort.Strings(orderedAccountIDs)
	transientCredentials := make(map[string]struct{}, transientAccountCount)
	for index := range transientAccountCount {
		accountID := orderedAccountIDs[index*accountCount/transientAccountCount]
		transientCredentials[strings.TrimPrefix(accountID, "load-account-")] = struct{}{}
	}
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int64
	var injectedFailures atomic.Int64
	var failedAccounts sync.Map
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer load-key-")
		if _, shouldFail := transientCredentials[credential]; shouldFail {
			if _, alreadyFailed := failedAccounts.LoadOrStore(credential, struct{}{}); !alreadyFailed {
				injectedFailures.Add(1)
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, `{"error":{"code":"server_error"}}`)
				return
			}
		}
		_, _ = io.WriteString(w, `{"id":"resp-load","object":"response","status":"completed","model":"gpt-4o-mini","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer upstream.Close()

	accountStore := accounts.NewMemoryAccountConfigStore()
	secretStore := accounts.NewMemorySecretStore()
	for i := range accountCount {
		id := "load-account-" + strconv.Itoa(i)
		ref, err := accounts.NewReference(id)
		if err != nil {
			t.Fatal(err)
		}
		if err := accountStore.Put(context.Background(), &accounts.AccountConfig{ID: id, ProviderID: "openai", Kind: accounts.KindAPIKey, Enabled: true, CredentialRef: ref}); err != nil {
			t.Fatal(err)
		}
		if err := secretStore.PutAccess(context.Background(), id, accounts.NewSecret([]byte("load-key-"+strconv.Itoa(i)))); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Config{MaxConcurrent: requestCount, MaxConcurrentStream: requestCount, RequestTimeout: 30 * time.Second, MaxBodyBytes: 1 << 20}.WithDefaults()
	var observedPool *proxy.AccountPool
	handler, err := buildHandlerWith(cfg, BootstrapDependencies{
		Registry:           registry,
		Accounts:           accountStore,
		Secrets:            secretStore,
		BaseURLOverrides:   map[string]string{"openai": upstream.URL},
		ObserveAccountPool: func(pool *proxy.AccountPool) { observedPool = pool },
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConns: 512, MaxIdleConnsPerHost: 512, MaxConnsPerHost: 512}}
	jobs := make(chan int)
	const workers = 64
	var wg sync.WaitGroup
	var failures sync.Map
	latencies := make(chan time.Duration, requestCount)
	var successes atomic.Int64
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				started := time.Now()
				body := `{"model":"gpt-4o-mini","messages":[{"role":"user","content":"load"}]}`
				resp, err := client.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(body))
				if err != nil {
					failures.Store(err.Error(), true)
					latencies <- time.Since(started)
					continue
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				latencies <- time.Since(started)
				if resp.StatusCode != http.StatusOK {
					failures.Store(fmt.Sprintf("status %d", resp.StatusCode), true)
				} else {
					successes.Add(1)
				}
			}
		}()
	}
	for i := range requestCount {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	close(latencies)
	failures.Range(func(key, _ any) bool {
		t.Errorf("load failure: %v", key)
		return true
	})
	if got := successes.Load(); got != requestCount {
		t.Fatalf("successful requests=%d, want %d", got, requestCount)
	}
	if got := injectedFailures.Load(); got != transientAccountCount {
		t.Fatalf("injected transient failures=%d, want %d", got, transientAccountCount)
	}
	if got, want := attempts.Load(), int64(requestCount+transientAccountCount); got != want {
		t.Fatalf("upstream attempts=%d, want exact failover count %d", got, want)
	}
	if observedPool == nil {
		t.Fatal("runtime account pool was not observed")
	}
	for i := range accountCount {
		id := "load-account-" + strconv.Itoa(i)
		if got := observedPool.InFlight(id); got != 0 {
			t.Fatalf("account %s leaked %d leases", id, got)
		}
	}
	reportedLatencies := make([]time.Duration, 0, requestCount)
	for latency := range latencies {
		reportedLatencies = append(reportedLatencies, latency)
	}
	if len(reportedLatencies) != requestCount {
		t.Fatalf("latency samples=%d, want %d", len(reportedLatencies), requestCount)
	}
	sort.Slice(reportedLatencies, func(i, j int) bool { return reportedLatencies[i] < reportedLatencies[j] })
	t.Logf("10k failure profile: success=%d/%d success_rate=%.2f%% attempts=%d transient_failures=%d latency_p50=%s latency_p95=%s latency_p99=%s", successes.Load(), requestCount, float64(successes.Load())*100/requestCount, attempts.Load(), injectedFailures.Load(), reportedLatencies[len(reportedLatencies)*50/100], reportedLatencies[len(reportedLatencies)*95/100], reportedLatencies[len(reportedLatencies)*99/100])
}
