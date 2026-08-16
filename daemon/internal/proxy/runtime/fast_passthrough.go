package proxy

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/healing"
)

// IsSameSurface reports whether the source and target protocols are the same
// surface, meaning a same-surface passthrough can avoid full AST reconstruction.
func IsSameSurface(source contracts.Surface, target contracts.Surface) bool {
	return source == target
}

// SanitizeSameSurfaceRequest performs in-place healing and sanitization of a
// same-surface request body. It parses the raw JSON, applies model suffix parsing,
// applies tool healing, applies thinking config, normalizes developer role for
// OpenAI targets, and re-serializes preserving all unknown/custom fields.
//
// Returns the sanitized body, the cleaned model string, and any error encountered.
func SanitizeSameSurfaceRequest(ctx context.Context, surface contracts.Surface, model string, body []byte) ([]byte, string, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, "", fmt.Errorf("failed to parse request body: %w", err)
	}

	// 1. Parse model suffix and extract thinking intent
	cleanModel, thinkingIntent := healing.ParseModelSuffix(model)
	if cleanModel != "" {
		payload["model"] = cleanModel
	} else {
		cleanModel = model
	}

	// 2. Extract thinking intent from body if not already in model suffix
	if thinkingIntent == nil {
		bodyIntent := healing.ExtractThinkingIntent(payload)
		if bodyIntent != nil {
			thinkingIntent = bodyIntent
		}
	}

	// 3. Apply thinking config to target surface
	if thinkingIntent != nil {
		healing.ApplyThinking(surface, cleanModel, payload, thinkingIntent)
	}

	// 4. In-place tool healing (FixMissingToolResponses and SanitizeToolIDs)
	if msgsRaw, ok := payload["messages"].([]any); ok && len(msgsRaw) > 0 {
		var messages []map[string]any
		allMaps := true
		for _, m := range msgsRaw {
			if mMap, ok := m.(map[string]any); ok {
				messages = append(messages, mMap)
			} else {
				allMaps = false
				break
			}
		}
		if allMaps {
			sanitized, _ := healing.SanitizeToolIDs(messages)
			fixed, _ := healing.FixMissingToolResponses(sanitized)
			newMsgs := make([]any, len(fixed))
			for i, fm := range fixed {
				newMsgs[i] = fm
			}
			payload["messages"] = newMsgs
		}
	}

	// 5. Normalize developer role to system for OpenAI Chat targets
	if surface == contracts.SurfaceOpenAIChat {
		if role, ok := payload["role"].(string); ok && role == "developer" {
			payload["role"] = "system"
		}
		if msgsRaw, ok := payload["messages"].([]any); ok {
			for i, m := range msgsRaw {
				if mMap, ok := m.(map[string]any); ok {
					if r, ok := mMap["role"].(string); ok && r == "developer" {
						mMap["role"] = "system"
						msgsRaw[i] = mMap
					}
				}
			}
			payload["messages"] = msgsRaw
		}
	}

	// 6. Serialize back to JSON, preserving unknown vendor fields
	out, err := json.Marshal(payload)
	if err != nil {
		return nil, "", fmt.Errorf("failed to serialize sanitized body: %w", err)
	}

	return out, cleanModel, nil
}
