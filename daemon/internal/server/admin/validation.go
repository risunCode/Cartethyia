package admin

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

const maxAdminField = 256

func validateAdminPayload(v any) error {
	switch value := v.(type) {
	case *AccountInput:
		return validateAccountInput(*value)
	case *APIKeyInput:
		return validateAPIKeyInput(*value)
	case *ProxyInput:
		return validateProxyInput(*value)
	case *ProxySettingsInput:
		return validateProxySettingsInput(*value)
	case *RuntimeSettingsInput:
		return validateRuntimeSettingsInput(*value)
	case *BackupCreateInput:
		return validateBackupCreateInput(*value)
	case *RestoreOptions:
		return nil
	case *ProbeInput:
		return validateProbeInput(*value)
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

func validateAccountInput(input AccountInput) error {
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

func validateAPIKeyInput(input APIKeyInput) error {
	if len(input.Name) > maxAdminField {
		return errors.New("key name is bounded")
	}
	if len(input.Scopes) > 64 {
		return errors.New("too many key scopes")
	}
	for _, scope := range input.Scopes {
		if err := bounded("scope", scope); err != nil {
			return err
		}
	}
	return validateMetadata(input.Metadata)
}

func validateProxyInput(input ProxyInput) error {
	if err := bounded("label", input.Label); err != nil {
		return err
	}
	if err := bounded("protocol", input.Protocol); err != nil {
		return err
	}
	if strings.TrimSpace(input.Host) == "" || len(input.Host) > maxAdminField {
		return errors.New("proxy host is required and bounded")
	}
	if net.ParseIP(input.Host) == nil && strings.ContainsAny(input.Host, " /\\") {
		return errors.New("proxy host is invalid")
	}
	if input.Port < 1 || input.Port > 65535 {
		return errors.New("proxy port is invalid")
	}
	if len(input.Password) > maxAdminField {
		return errors.New("proxy password is bounded")
	}
	return validateMetadata(input.Metadata)
}

func validateProxySettingsInput(input ProxySettingsInput) error {
	if input.Mode != nil && len(strings.TrimSpace(*input.Mode)) > maxAdminField {
		return errors.New("proxy mode is bounded")
	}
	if input.DefaultProxy != nil && len(strings.TrimSpace(*input.DefaultProxy)) > maxAdminField {
		return errors.New("default proxy is bounded")
	}
	if len(input.AllowList) > 256 || len(input.BlockList) > 256 {
		return errors.New("proxy settings list is too large")
	}
	return validateMetadata(input.Metadata)
}

func validateRuntimeSettingsInput(input RuntimeSettingsInput) error {
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

func validateBackupCreateInput(input BackupCreateInput) error {
	if len(input.Note) > maxAdminField {
		return errors.New("backup note is bounded")
	}
	return nil
}

func validateProbeInput(input ProbeInput) error {
	if len(input.URL) > 2048 {
		return errors.New("probe URL is bounded")
	}
	u, err := url.ParseRequestURI(input.URL)
	if err != nil || u == nil || u.Scheme == "" || u.Host == "" {
		return errors.New("probe URL is invalid")
	}
	if len(input.Body) > 64*1024 {
		return errors.New("probe body is bounded")
	}
	if len(input.Headers) > 64 {
		return errors.New("too many probe headers")
	}
	return nil
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
