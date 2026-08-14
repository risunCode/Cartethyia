// Package contract is the narrow provider-neutral account boundary. The
// top-level accounts package remains the compatibility owner while callers
// migrate incrementally to this package.
package contract

import "github.com/cartethyia/daemon/internal/accounts"

type AuthDriver = accounts.AuthDriver
type OAuthStartInput = accounts.OAuthStartInput
type OAuthStartResult = accounts.OAuthStartResult
type OAuthPollResult = accounts.OAuthPollResult
type OAuthExchangeInput = accounts.OAuthExchangeInput
type RefreshTokenInput = accounts.RefreshTokenInput
type RevokeTokenInput = accounts.RevokeTokenInput
type OAuthFlowKind = accounts.OAuthFlowKind
type PollStatus = accounts.PollStatus
type TokenSet = accounts.TokenSet
type Secret = accounts.Secret
type CredentialKind = accounts.CredentialKind
type CredentialOrigin = accounts.CredentialOrigin
type AccountConfig = accounts.AccountConfig
type OAuthTokenRecord = accounts.OAuthTokenRecord
type Capabilities = accounts.Capabilities

type DriverInfo = accounts.DriverInfo

const (
	FlowBrowser    = accounts.FlowBrowser
	FlowDevice     = accounts.FlowDevice
	PollPending    = accounts.PollPending
	PollCompleted  = accounts.PollCompleted
	PollExpired    = accounts.PollExpired
	PollDenied     = accounts.PollDenied
	PollError      = accounts.PollError
	KindAPIKey     = accounts.KindAPIKey
	KindOAuth      = accounts.KindOAuth
	KindDevice     = accounts.KindDevice
	KindAccessOnly = accounts.KindAccessOnly
	KindCustom     = accounts.KindCustom
)
