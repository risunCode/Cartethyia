package flow

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

// ParseLoopbackCallback accepts only loopback callback URLs and returns the
// bounded code/state values. It rejects remote hosts and fragment-only values.
func ParseLoopbackCallback(raw string) (code, state string, providerError string, err error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "http" {
		return "", "", "", ErrInvalidCallback
	}
	host := u.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return "", "", "", ErrInvalidCallback
		}
	}
	q := u.Query()
	if e := strings.TrimSpace(q.Get("error")); e != "" {
		return "", strings.TrimSpace(q.Get("state")), bounded(e, 96), nil
	}
	code = strings.TrimSpace(q.Get("code"))
	state = strings.TrimSpace(q.Get("state"))
	if code == "" || state == "" {
		return "", "", "", errors.New("oauth flow: callback code and state are required")
	}
	return bounded(code, maxTokenBytes), bounded(state, maxTokenBytes), "", nil
}
