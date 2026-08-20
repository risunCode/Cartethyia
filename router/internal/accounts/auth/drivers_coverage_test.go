package auth

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type kiroCoverageTransport struct {
	token string
}

func (t *kiroCoverageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	payload := `{}`
	switch r.URL.Path {
	case "/client/register":
		payload = `{"clientId":"client-1","clientSecret":"secret-1"}`
	case "/device_authorization":
		payload = `{"deviceCode":"device-1","userCode":"ABCD","verificationUri":"https://aws.test/verify","expiresIn":120,"interval":2}`
	case "/oauth/token":
		switch t.token {
		case "pending":
			payload = `{"error":"authorization_pending"}`
		case "slow":
			payload = `{"error":"slow_down"}`
		case "denied":
			payload = `{"error":"access_denied"}`
		default:
			payload = `{"accessToken":"access-1","refreshToken":"refresh-1","expiresIn":3600,"profileArn":"arn:profile"}`
		}
	case "/social/token":
		payload = `{"accessToken":"social-access","refreshToken":"social-refresh","expiresIn":900,"profileArn":"social-profile"}`
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(payload)),
		Request:    r,
	}, nil
}

func newKiroCoverageDriver(tr *kiroCoverageTransport) *KiroDriver {
	d, err := NewKiro(Config{
		ProviderID:          ProviderKiro,
		HTTPClient:          &http.Client{Transport: tr},
		Now:                 func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		KiroAWS:             true,
		KiroAWSStartURL:     "https://aws.test/start",
		KiroAWSClientName:   "kiro-test",
		KiroAWSClientType:   "public",
		KiroAWSIssuerURL:    "https://aws.test/issuer",
		KiroAWSGrantTypes:   []string{"device_code", "refresh_token"},
		KiroSocialAuthorize: "https://social.test/authorize",
		KiroSocialToken:     "https://social.test/social/token",
		Endpoints: Endpoints{
			Device: "https://aws.test/device_authorization",
			Token:  "https://aws.test/oauth/token",
		},
	})
	if err != nil {
		panic(err)
	}
	return d
}

func TestKiroSocialStartAndExchange(t *testing.T) {
	d := newKiroCoverageDriver(&kiroCoverageTransport{})
	if _, err := d.StartSocial(context.Background(), "twitter", ""); Classify(err) != ErrKindInvalidRequest {
		t.Fatalf("unsupported social provider error = %v", err)
	}
	start, err := d.StartSocial(context.Background(), " GOOGLE ", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(start.AuthorizationURL, "idp=Google") || start.Flow != FlowBrowser {
		t.Fatalf("social start = %#v", start)
	}
	if _, err := d.Exchange(context.Background(), OAuthExchangeInput{State: start.State}); Classify(err) != ErrKindInvalidRequest {
		t.Fatalf("missing social code error = %v", err)
	}
	ts, err := d.Exchange(context.Background(), OAuthExchangeInput{State: start.State, Code: "social-code"})
	if err != nil {
		t.Fatal(err)
	}
	if ts.Access.RevealString() != "social-access" {
		t.Fatalf("social token set = %#v", ts)
	}
	ts.Close()
	if _, err := d.Exchange(context.Background(), OAuthExchangeInput{State: start.State, Code: "social-code"}); Classify(err) != ErrKindInvalidRequest {
		t.Fatalf("reused social state error = %v", err)
	}
}

func TestKiroAWSStartAndPollStatuses(t *testing.T) {
	tr := &kiroCoverageTransport{}
	d := newKiroCoverageDriver(tr)
	start, err := d.Start(context.Background(), OAuthStartInput{Flow: FlowDevice, AWSMode: "builder-id", AWSStartURL: " https://aws.test/custom "})
	if err != nil {
		t.Fatal(err)
	}
	if start.Flow != FlowDevice || start.UserCode != "ABCD" || start.IntervalSeconds != 2 {
		t.Fatalf("AWS start = %#v", start)
	}
	if _, err := d.Start(context.Background(), OAuthStartInput{Flow: FlowDevice, AWSMode: "invalid"}); Classify(err) != ErrKindInvalidRequest {
		t.Fatalf("invalid AWS mode error = %v", err)
	}
	for _, status := range []string{"pending", "slow", "denied"} {
		tr.token = status
		got, err := d.Poll(context.Background(), start.State)
		if err != nil {
			t.Fatal(err)
		}
		want := PollPending
		if status == "denied" {
			want = PollDenied
		}
		if got.Status != want {
			t.Fatalf("poll %s = %#v", status, got)
		}
	}
	tr.token = ""
	complete, err := d.Poll(context.Background(), start.State)
	if err != nil || complete.Status != PollCompleted || complete.TokenSet.ProviderAccountID != "arn:profile" {
		t.Fatalf("completed poll = %#v %v", complete, err)
	}
	complete.TokenSet.Close()
	if _, err := d.Poll(context.Background(), start.State); Classify(err) != ErrKindInvalidRequest {
		t.Fatalf("missing device state error = %v", err)
	}
}
