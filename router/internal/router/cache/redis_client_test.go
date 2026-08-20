package cache

import "testing"

func TestNewRedisClientRejectsUnsupportedConfiguration(t *testing.T) {
	for _, raw := range []string{"", "http://localhost:6379", "redis://"} {
		if _, err := NewRedisClient(raw, 0); err == nil {
			t.Fatalf("expected Redis URL error for %q", raw)
		}
	}
	if err := ParseRedisURL("redis://localhost:6379"); err != nil {
		t.Fatalf("valid Redis URL rejected: %v", err)
	}
	client, err := NewRedisClient("redis://localhost:6379", 0)
	if err != nil {
		t.Fatalf("valid Redis URL did not compose: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}
