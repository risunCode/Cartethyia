package runtime

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/config"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
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
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
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
		if err := secretStore.PutAccess(context.Background(), id, accounts.NewSecret([]byte("load-key"))); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Config{MaxConcurrent: requestCount, MaxConcurrentStream: requestCount, RequestTimeout: 30 * time.Second, MaxBodyBytes: 1 << 20}.WithDefaults()
	handler, err := buildHandlerWith(cfg, BootstrapDependencies{
		Registry:         registry,
		Accounts:         accountStore,
		Secrets:          secretStore,
		BaseURLOverrides: map[string]string{"openai": upstream.URL},
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
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				body := `{"model":"gpt-4o-mini","messages":[{"role":"user","content":"load"}]}`
				resp, err := client.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(body))
				if err != nil {
					failures.Store(err.Error(), true)
					continue
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					failures.Store(fmt.Sprintf("status %d", resp.StatusCode), true)
				}
			}
		}()
	}
	for i := range requestCount {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	failures.Range(func(key, _ any) bool {
		t.Errorf("load failure: %v", key)
		return false
	})
}
