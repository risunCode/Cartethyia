package api

import "testing"

func TestAccountDisplayUsesEmailNameIDPrecedence(t *testing.T) {
	cases := []struct {
		name             string
		email, label, id string
		want             string
	}{
		{name: "email", email: "owner@example.test", label: "Owner", id: "acct-1", want: "owner@example.test"},
		{name: "label", label: "Owner", id: "acct-1", want: "Owner"},
		{name: "id", id: "acct-1", want: "acct-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AccountDisplay(tc.email, tc.label, tc.id); got != tc.want {
				t.Fatalf("display=%q want=%q", got, tc.want)
			}
		})
	}
}

func TestProxyDisplayUsesNameThenID(t *testing.T) {
	if got := ProxyDisplay("Office proxy", "proxy-1"); got != "Office proxy" {
		t.Fatalf("display=%q", got)
	}
	if got := ProxyDisplay("", "proxy-1"); got != "proxy-1" {
		t.Fatalf("fallback display=%q", got)
	}
}

func TestValidateRequestIDRejectsHeaderInjection(t *testing.T) {
	if err := ValidateRequestID("request_id", "req-123"); err != nil {
		t.Fatalf("valid id rejected: %v", err)
	}
	if err := ValidateRequestID("request_id", "req\r\nInjected: yes"); err == nil {
		t.Fatal("header injection id accepted")
	}
}
