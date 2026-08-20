package auth

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// MaxCredentialImportBytes bounds manually imported credential documents before
// they are parsed. The import path never includes the original document in an
// error, log, or persisted account field.
const MaxCredentialImportBytes = 128 << 10

// ImportedCredential is the account-owned result of a credential import. The
// token material is available only through TokenSet.Secret fields; Labels are
// bounded, non-secret operator metadata.
type ImportedCredential struct {
	TokenSet *TokenSet
	Labels   map[string]string
}

// ImportKiroJSON imports the supported Kiro credential document shape. Both
// camelCase and snake_case token fields are accepted so credentials exported by
// the desktop client and by the AWS tooling have the same account path.
func ImportKiroJSON(raw string, now time.Time) (ImportedCredential, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxCredentialImportBytes {
		return ImportedCredential{}, errors.New("auth: bounded Kiro credential JSON is required")
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return ImportedCredential{}, errors.New("auth: Kiro credential JSON is malformed")
	}
	access := importedJSONString(value, "access_token", "accessToken")
	refresh := importedJSONString(value, "refresh_token", "refreshToken")
	if access == "" || refresh == "" {
		return ImportedCredential{}, errors.New("auth: Kiro credential JSON requires access and refresh tokens")
	}
	if now.IsZero() {
		now = time.Now()
	}
	profile := importedJSONString(value, "profile_arn", "profileArn")
	labels := map[string]string{"mode": "manual-json"}
	if profile != "" {
		labels["profileArn"] = bounded(profile, maxImportLabelBytes)
	}
	if region := importedJSONString(value, "region"); region != "" {
		labels["region"] = bounded(region, maxImportLabelBytes)
	}
	return ImportedCredential{
		TokenSet: &TokenSet{
			Access:            NewSecretFromString(access),
			Refresh:           NewSecretFromString(refresh),
			Origin:            OriginExternal,
			ExpiresAt:         importedExpiry(value, now),
			ProviderAccountID: bounded(profile, maxImportLabelBytes),
			Email:             bounded(importedJSONString(value, "email", "username", "preferred_username"), maxImportLabelBytes),
			Scope:             bounded(importedJSONString(value, "scope", "scopes"), maxImportLabelBytes),
		},
		Labels: labels,
	}, nil
}

const maxImportLabelBytes = 128

func importedJSONString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		raw, ok := value[key]
		if !ok {
			continue
		}
		switch v := raw.(type) {
		case string:
			if text := strings.TrimSpace(v); text != "" {
				return text
			}
		case []any:
			parts := make([]string, 0, len(v))
			for _, item := range v {
				if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
					parts = append(parts, strings.TrimSpace(text))
				}
			}
			if len(parts) > 0 {
				return strings.Join(parts, " ")
			}
		}
	}
	return ""
}

func importedExpiry(value map[string]any, now time.Time) time.Time {
	for _, key := range []string{"expires_at", "expiresAt", "expired"} {
		if text := importedJSONString(value, key); text != "" {
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				return parsed
			}
		}
	}
	for _, key := range []string{"expires_in", "expiresIn"} {
		if raw, ok := value[key].(float64); ok && raw > 0 && raw < 365*24*3600 {
			return now.Add(time.Duration(raw) * time.Second)
		}
	}
	return now.Add(time.Hour)
}
