package contracts

import (
	"errors"
	"strings"
	"testing"
)

func validExchange() Exchange {
	return Exchange{
		Surface:        SurfaceOpenAIChat,
		RequestedModel: "gpt-5",
		Messages: []Message{{
			Role:   RoleUser,
			Blocks: []ContentBlock{{Kind: BlockText, Text: "hello"}},
		}},
		Limits:      Limits{MaxBodyBytes: 1 << 20, MaxOutputTokens: 4096},
		CachePolicy: CacheAutomatic,
	}
}

func validCandidate(id string) Candidate {
	ref, _ := NewCredentialRef("account-ref-1")
	return Candidate{
		ID:            id,
		ProviderID:    "openai",
		ModelID:       "gpt-5",
		Surface:       SurfaceOpenAIChat,
		CredentialRef: ref,
		Enabled:       true,
		Authorized:    true,
		Compatible:    true,
	}
}

func TestExchangeValidateAcceptsBoundedCanonicalShape(t *testing.T) {
	if err := validExchange().Validate(); err != nil {
		t.Fatalf("valid exchange rejected: %v", err)
	}
}

func TestExchangeValidateRejectsUnboundedFields(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Exchange)
	}{
		{
			name: "model",
			edit: func(e *Exchange) { e.RequestedModel = strings.Repeat("m", MaxIdentifierBytes+1) },
		},
		{
			name: "metadata",
			edit: func(e *Exchange) {
				e.Metadata.Values = map[string]string{"trace": strings.Repeat("x", MaxMetadataValueBytes+1)}
			},
		},
		{
			name: "native json",
			edit: func(e *Exchange) {
				e.Messages[0].Blocks = []ContentBlock{{
					Kind:   BlockNative,
					Native: JSONFragment(strings.Repeat("x", MaxNativePayloadBytes+1)),
				}}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			exchange := validExchange()
			tc.edit(&exchange)
			if err := exchange.Validate(); !errors.Is(err, ErrContractBounds) {
				t.Fatalf("Validate error = %v, want ErrContractBounds", err)
			}
		})
	}
}

func TestNewJSONFragmentClonesAndValidates(t *testing.T) {
	raw := []byte(`{"type":"native"}`)
	fragment, err := NewJSONFragment(raw)
	if err != nil {
		t.Fatalf("NewJSONFragment: %v", err)
	}
	raw[0] = 'X'
	if string(fragment) != `{"type":"native"}` {
		t.Fatalf("fragment changed with source mutation: %q", fragment)
	}
	if _, err := NewJSONFragment([]byte(`{"broken"`)); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("malformed fragment error = %v, want ErrInvalidContract", err)
	}
}

func TestCredentialReferenceIsOpaqueAndBounded(t *testing.T) {
	ref, err := NewCredentialRef("account-ref-1")
	if err != nil {
		t.Fatalf("NewCredentialRef: %v", err)
	}
	if ref.String() != "account-ref-1" || ref.IsZero() {
		t.Fatalf("unexpected credential reference: %#v", ref)
	}
	if _, err := NewCredentialRef(strings.Repeat("r", MaxIdentifierBytes+1)); !errors.Is(err, ErrContractBounds) {
		t.Fatalf("oversize credential ref error = %v, want ErrContractBounds", err)
	}
}

func TestRoutePlanValidateRejectsDuplicateAttempts(t *testing.T) {
	plan := RoutePlan{
		SnapshotGeneration: 7,
		Candidate:          validCandidate("account-a"),
		Attempts:           []Candidate{validCandidate("account-a"), validCandidate("account-a")},
		CacheIntent:        CacheAutomatic,
	}
	if err := plan.Validate(); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("Validate error = %v, want ErrInvalidContract", err)
	}
}

func TestFailureValidateRejectsUnboundedMessage(t *testing.T) {
	failure := Failure{
		Code:       FailureProviderProtocol,
		ProviderID: "openai",
		Message:    strings.Repeat("x", MaxFailureMessageBytes+1),
	}
	if err := failure.Validate(); !errors.Is(err, ErrContractBounds) {
		t.Fatalf("Validate error = %v, want ErrContractBounds", err)
	}
}
