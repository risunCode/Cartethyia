package proxy

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"strings"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

const (
	// DefaultMaxRepairAttempts is the conservative request-wide compatibility
	// repair budget. Every accepted repair replay still consumes the router's
	// global upstream attempt budget.
	DefaultMaxRepairAttempts = 1
	maxRepairRuleIDBytes     = 96
)

// CompatibilityRepairTransport is an optional, pure provider-policy boundary.
// It proposes a normalized replacement body but performs no upstream call;
// the router remains the sole owner of applying and replaying proposals.
type CompatibilityRepairTransport interface {
	ProposeRepair(acct Account, req contracts.Request, ruleID string) (providers.RepairProposal, bool)
}

// RepairEvidence is the complete bounded observability payload for a proposal.
// It intentionally cannot carry request bodies, body hashes, or user content.
type RepairEvidence struct {
	Provider string
	RuleID   string
	Attempt  int
	Changed  bool
}

// RepairObserver receives bounded request-local compatibility repair evidence.
type RepairObserver func(RepairEvidence)

// RepairState owns one request's compatibility repair limits and attempted-body
// hashes. It is intentionally not reusable across requests.
type RepairState struct {
	maxRepairs int
	repairs    int
	attempted  map[[sha256.Size]byte]struct{}
	perRule    map[repairRuleKey]int
	observe    RepairObserver
}

type repairRuleKey struct {
	provider string
	ruleID   string
}

// NewRepairState creates request-local repair state and records the initial
// request body as already attempted. Non-positive limits use the conservative
// default rather than disabling loop protection.
func NewRepairState(initialBody []byte, maxRepairs int, observe RepairObserver) *RepairState {
	if maxRepairs <= 0 {
		maxRepairs = DefaultMaxRepairAttempts
	}
	initialHash := sha256.Sum256(initialBody)
	return &RepairState{
		maxRepairs: maxRepairs,
		attempted:  map[[sha256.Size]byte]struct{}{initialHash: {}},
		perRule:    make(map[repairRuleKey]int),
		observe:    observe,
	}
}

// Apply validates and records one provider proposal. It rejects unchanged
// bodies, bodies attempted earlier in the request, invalid rule identifiers,
// and exhausted per-rule or request-wide limits. The per-rule cap is one.
func (s *RepairState) Apply(provider string, attempt int, currentBody []byte, proposal providers.RepairProposal) ([]byte, RepairEvidence, bool) {
	if s == nil {
		return nil, RepairEvidence{}, false
	}
	ruleID, validRule := boundedRepairRuleID(proposal.RuleID)
	if !validRule {
		return nil, RepairEvidence{}, false
	}
	evidence := RepairEvidence{
		Provider: boundedRepairProvider(provider),
		RuleID:   ruleID,
		Attempt:  attempt,
		Changed:  !bytes.Equal(currentBody, proposal.Body),
	}
	if s.observe != nil {
		s.observe(evidence)
	}
	if !evidence.Changed || s.repairs >= s.maxRepairs {
		return nil, evidence, false
	}
	key := repairRuleKey{provider: evidence.Provider, ruleID: ruleID}
	if s.perRule[key] >= 1 {
		return nil, evidence, false
	}
	hash := sha256.Sum256(proposal.Body)
	if _, attempted := s.attempted[hash]; attempted {
		return nil, evidence, false
	}
	s.attempted[hash] = struct{}{}
	s.perRule[key]++
	s.repairs++
	return append([]byte(nil), proposal.Body...), evidence, true
}

type repairRuleError struct {
	cause  error
	ruleID string
}

func (e *repairRuleError) Error() string { return e.cause.Error() }
func (e *repairRuleError) Unwrap() error { return e.cause }
func (e *repairRuleError) RepairRuleID() string {
	if e == nil {
		return ""
	}
	return e.ruleID
}

// WithRepairRule attaches only a stable, bounded rule identifier to an error.
// Replacement bodies and request-body hashes never enter the error chain.
func WithRepairRule(err error, ruleID string) error {
	if err == nil {
		return nil
	}
	bounded, ok := boundedRepairRuleID(ruleID)
	if !ok {
		return err
	}
	return &repairRuleError{cause: err, ruleID: bounded}
}

// RepairRuleFrom returns a stable repair rule carried by err, if present.
func RepairRuleFrom(err error) (string, bool) {
	var carrier interface{ RepairRuleID() string }
	if !errors.As(err, &carrier) {
		return "", false
	}
	ruleID, ok := boundedRepairRuleID(carrier.RepairRuleID())
	return ruleID, ok
}

func boundedRepairProvider(provider string) string {
	provider = strings.TrimSpace(provider)
	if len(provider) > maxRepairRuleIDBytes {
		provider = provider[:maxRepairRuleIDBytes]
	}
	return provider
}

func boundedRepairRuleID(ruleID string) (string, bool) {
	ruleID = strings.TrimSpace(ruleID)
	if ruleID == "" || len(ruleID) > maxRepairRuleIDBytes {
		return "", false
	}
	for _, r := range ruleID {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return "", false
	}
	return ruleID, true
}
