package api

import (
	"errors"
	"fmt"
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"net"
	"strings"
)

const maxAdminField = 256

const (
	maxProxyTypeLen = 16
	maxProxyHostLen = 255
)

func validateAdminPayload(v any) error {
	switch value := v.(type) {
	case *consolecontracts.AccountInput:
		return validateAccountInput(*value)
	case *consolecontracts.RuntimeSettingsInput:
		return validateRuntimeSettingsInput(*value)
	case *consolecontracts.ClientErrorInput:
		level := strings.ToLower(strings.TrimSpace(value.Level))
		if err := bounded("level", level); err != nil {
			return err
		}
		switch level {
		case "trace", "debug", "info", "warn", "error", "fatal":
		default:
			return errors.New("log level is invalid")
		}
		if err := bounded("message", value.Message); err != nil || strings.TrimSpace(value.Message) == "" {
			return errors.New("message is required and bounded")
		}
		return validateMetadata(value.Context)
	case *OAuthStartInput:
		if err := bounded("accountId", value.AccountID); err != nil {
			return err
		}
		if len(value.Scopes) > 64 {
			return errors.New("oauth scopes are bounded")
		}
		for _, scope := range value.Scopes {
			if err := bounded("oauth scope", scope); err != nil {
				return err
			}
		}
	case *OAuthCompleteInput:
		if strings.TrimSpace(value.Code) == "" || len(value.Code) > maxAdminField {
			return errors.New("oauth code is required and bounded")
		}
	case *OAuthRefreshInput:
		if strings.TrimSpace(value.AccountID) == "" || len(value.AccountID) > maxAdminField {
			return errors.New("oauth accountId is required and bounded")
		}
	}
	return nil
}

func validateAccountInput(input consolecontracts.AccountInput) error {
	for name, value := range map[string]string{
		"label": input.Label, "credentialRef": input.CredentialRef, "model": input.Model,
		"name": input.Name, "email": input.Email, "providerAccountId": input.ProviderAccountID,
		"orgId": input.OrgID, "orgName": input.OrgName, "projectId": input.ProjectID,
	} {
		if err := bounded(name, value); err != nil {
			return err
		}
	}
	return validateMetadata(input.Metadata)
}

func validateRuntimeSettingsInput(input consolecontracts.RuntimeSettingsInput) error {
	if input.LogLevel != nil {
		level := strings.ToLower(strings.TrimSpace(*input.LogLevel))
		switch level {
		case "trace", "debug", "info", "warn", "error":
		default:
			return errors.New("log level is invalid")
		}
	}
	if input.ListenAddr != nil {
		if len(strings.TrimSpace(*input.ListenAddr)) > maxAdminField {
			return errors.New("listen address is bounded")
		}
		if _, _, err := net.SplitHostPort(strings.TrimSpace(*input.ListenAddr)); err != nil {
			return errors.New("listen address is invalid")
		}
	}
	if len(input.Flags) > 128 {
		return errors.New("too many runtime flags")
	}
	return validateMetadata(input.Metadata)
}

func bounded(name, value string) error {
	if len(value) > maxAdminField || strings.IndexByte(value, 0) >= 0 {
		return fmt.Errorf("%s is invalid or too long", name)
	}
	return nil
}

func validateMetadata(metadata map[string]any) error {
	if len(metadata) > 64 {
		return errors.New("too many metadata fields")
	}
	for key := range metadata {
		if err := bounded("metadata key", key); err != nil {
			return err
		}
		lower := strings.ToLower(key)
		if strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "credential") {
			return errors.New("metadata contains a forbidden secret field")
		}
	}
	return nil
}

// validateProxyInput enforces the shared contract for proxy create/update
// payloads. requireAll mirrors the repository convention: true on Create
// (Type/Host/Port are mandatory), false on Update (any field is optional).
func validateProxyInput(input consolecontracts.ProxyInput, requireAll bool) *Error {
	if requireAll {
		if input.Type == nil {
			return NewError(CodeInvalidRequest, "type is required")
		}
		if input.Host == nil {
			return NewError(CodeInvalidRequest, "host is required")
		}
		if input.Port == nil {
			return NewError(CodeInvalidRequest, "port is required")
		}
	}
	if input.Type != nil {
		switch *input.Type {
		case "http", "https", "socks5":
			// valid
		default:
			return NewError(CodeInvalidRequest, "type must be http, https, or socks5")
		}
		if len(*input.Type) > maxProxyTypeLen {
			return NewError(CodeInvalidRequest, "type is too long")
		}
	}
	if input.Host != nil {
		if len(*input.Host) > maxProxyHostLen {
			return NewError(CodeInvalidRequest, "host is too long")
		}
		if strings.ContainsAny(*input.Host, " \t\r\n") {
			return NewError(CodeInvalidRequest, "host contains whitespace")
		}
	}
	if input.Port != nil && (*input.Port < 1 || *input.Port > 65535) {
		return NewError(CodeInvalidRequest, "port must be 1-65535")
	}
	if input.Priority != nil && (*input.Priority < 0 || *input.Priority > 1000) {
		return NewError(CodeInvalidRequest, "priority must be 0-1000")
	}
	if input.Weight != nil && (*input.Weight < 1 || *input.Weight > 1000) {
		return NewError(CodeInvalidRequest, "weight must be 1-1000")
	}
	if input.MaxConcurrency != nil && (*input.MaxConcurrency < 1 || *input.MaxConcurrency > 10000) {
		return NewError(CodeInvalidRequest, "max_concurrency must be 1-10000")
	}
	return nil
}
