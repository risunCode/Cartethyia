package outbound

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestSecurityVerificationPolicyErrorsDoNotEchoURLCredentials(t *testing.T) {
	const secret = "ssrf-secret-value"
	policy := Policy{AllowPrivate: true, AllowLoopback: true, Resolver: staticResolver{"public.test": {{IP: net.ParseIP("93.184.216.34")}}}}
	_, err := policy.Validate(context.Background(), "https://operator:"+secret+"@public.test/v1")
	if err == nil || !errors.Is(err, ErrInvalidURL) || ErrorCode(err) != CodeInvalidURL {
		t.Fatalf("err=%v code=%q, want invalid URL", err, ErrorCode(err))
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("policy error echoed URL credential: %v", err)
	}
}
