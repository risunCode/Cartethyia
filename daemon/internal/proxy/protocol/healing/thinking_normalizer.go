package healing

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// ThinkingMode defines the representation of thinking/reasoning intent.
type ThinkingMode string

const (
	ModeNone   ThinkingMode = "none"
	ModeAuto   ThinkingMode = "auto"
	ModeBudget ThinkingMode = "budget"
	ModeLevel  ThinkingMode = "level"
)

// ThinkingIntent holds the parsed intent.
type ThinkingIntent struct {
	Mode   ThinkingMode
	Budget int
	Level  string
}

var modelSuffixPattern = regexp.MustCompile(`^(.*)\(([^()]+)\)\s*$`)

var levelToBudget = map[string]int{
	"low":    2048,
	"medium": 8192,
	"high":   16384,
}

// ParseModelSuffix extracts thinking suffix from model string e.g. "claude-3-7-sonnet(high)" -> ("claude-3-7-sonnet", intent).
func ParseModelSuffix(model string) (string, *ThinkingIntent) {
	if model == "" {
		return model, nil
	}
	m := modelSuffixPattern.FindStringSubmatch(model)
	if len(m) < 3 {
		return model, nil
	}
	cleanModel := strings.TrimSpace(m[1])
	raw := strings.ToLower(strings.TrimSpace(m[2]))

	if raw == "none" || raw == "off" {
		return cleanModel, &ThinkingIntent{Mode: ModeNone}
	}
	if raw == "auto" {
		return cleanModel, &ThinkingIntent{Mode: ModeAuto}
	}
	if num, err := strconv.Atoi(raw); err == nil && num > 0 {
		return cleanModel, &ThinkingIntent{Mode: ModeBudget, Budget: num}
	}
	if _, ok := levelToBudget[raw]; ok {
		return cleanModel, &ThinkingIntent{Mode: ModeLevel, Level: raw}
	}
	return cleanModel, nil
}

// ExtractThinkingIntent reads thinking intent from OpenAI, Anthropic, or Gemini payload structures.
func ExtractThinkingIntent(body map[string]any) *ThinkingIntent {
	if body == nil {
		return nil
	}

	// 1. Anthropic output_config.effort
	if oc, ok := body["output_config"].(map[string]any); ok {
		if effort, ok := oc["effort"].(string); ok && effort != "" {
			e := strings.ToLower(effort)
			if e == "none" || e == "off" {
				return &ThinkingIntent{Mode: ModeNone}
			}
			if e == "auto" {
				return &ThinkingIntent{Mode: ModeAuto}
			}
			return &ThinkingIntent{Mode: ModeLevel, Level: e}
		}
	}

	// 2. Anthropic thinking block
	if t, ok := body["thinking"].(map[string]any); ok {
		tType, _ := t["type"].(string)
		if tType == "disabled" {
			return &ThinkingIntent{Mode: ModeNone}
		}
		if tType == "adaptive" || tType == "enabled" {
			if budget, ok := t["budget_tokens"].(float64); ok && budget > 0 {
				return &ThinkingIntent{Mode: ModeBudget, Budget: int(budget)}
			}
			if budget, ok := t["budget_tokens"].(int); ok && budget > 0 {
				return &ThinkingIntent{Mode: ModeBudget, Budget: budget}
			}
			return &ThinkingIntent{Mode: ModeAuto}
		}
	}

	// 3. OpenAI reasoning_effort / reasoning.effort
	if effort, ok := body["reasoning_effort"].(string); ok && effort != "" {
		e := strings.ToLower(effort)
		if e == "none" || e == "off" {
			return &ThinkingIntent{Mode: ModeNone}
		}
		if e == "auto" {
			return &ThinkingIntent{Mode: ModeAuto}
		}
		return &ThinkingIntent{Mode: ModeLevel, Level: e}
	}
	if r, ok := body["reasoning"].(map[string]any); ok {
		if effort, ok := r["effort"].(string); ok && effort != "" {
			e := strings.ToLower(effort)
			if e == "none" || e == "off" {
				return &ThinkingIntent{Mode: ModeNone}
			}
			if e == "auto" {
				return &ThinkingIntent{Mode: ModeAuto}
			}
			return &ThinkingIntent{Mode: ModeLevel, Level: e}
		}
	}

	// 4. Gemini thinkingConfig
	var tc map[string]any
	if directTC, ok := body["thinkingConfig"].(map[string]any); ok {
		tc = directTC
	} else if gc, ok := body["generationConfig"].(map[string]any); ok {
		if nestedTC, ok := gc["thinkingConfig"].(map[string]any); ok {
			tc = nestedTC
		}
	}
	if tc != nil {
		if level, ok := tc["thinkingLevel"].(string); ok && level != "" {
			return &ThinkingIntent{Mode: ModeLevel, Level: strings.ToLower(level)}
		}
		if budget, ok := tc["thinkingBudget"].(float64); ok {
			if budget == 0 {
				return &ThinkingIntent{Mode: ModeNone}
			}
			if budget < 0 {
				return &ThinkingIntent{Mode: ModeAuto}
			}
			return &ThinkingIntent{Mode: ModeBudget, Budget: int(budget)}
		}
	}

	return nil
}

// ApplyThinking formats the payload for the target surface according to intent and clamps budgets.
func ApplyThinking(targetSurface contracts.Surface, model string, body map[string]any, intent *ThinkingIntent) {
	if body == nil || intent == nil {
		return
	}

	switch targetSurface {
	case contracts.SurfaceAnthropic:
		if intent.Mode == ModeNone {
			body["thinking"] = map[string]any{"type": "disabled"}
			delete(body, "reasoning_effort")
			delete(body, "thinkingConfig")
			return
		}
		budget := intent.Budget
		if intent.Mode == ModeLevel {
			if b, ok := levelToBudget[intent.Level]; ok {
				budget = b
			} else {
				budget = 8192
			}
		} else if intent.Mode == ModeAuto {
			budget = 8192
		}
		// Clamp budget for Anthropic (1024 - 64000)
		if budget < 1024 {
			budget = 1024
		} else if budget > 64000 {
			budget = 64000
		}
		body["thinking"] = map[string]any{
			"type":          "enabled",
			"budget_tokens": budget,
		}
		delete(body, "reasoning_effort")

	case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses:
		if intent.Mode == ModeNone {
			delete(body, "reasoning_effort")
			delete(body, "thinking")
			return
		}
		level := intent.Level
		if intent.Mode == ModeBudget {
			if intent.Budget <= 4096 {
				level = "low"
			} else if intent.Budget <= 16384 {
				level = "medium"
			} else {
				level = "high"
			}
		} else if intent.Mode == ModeAuto || level == "" {
			level = "medium"
		}
		body["reasoning_effort"] = level
		delete(body, "thinking")

	case contracts.SurfaceGemini:
		if intent.Mode == ModeNone {
			if gc, ok := body["generationConfig"].(map[string]any); ok {
				delete(gc, "thinkingConfig")
			}
			delete(body, "thinkingConfig")
			return
		}
		budget := intent.Budget
		if intent.Mode == ModeLevel {
			if b, ok := levelToBudget[intent.Level]; ok {
				budget = b
			} else {
				budget = 8192
			}
		}
		gc, ok := body["generationConfig"].(map[string]any)
		if !ok {
			gc = make(map[string]any)
			body["generationConfig"] = gc
		}
		gc["thinkingConfig"] = map[string]any{
			"thinkingBudget": budget,
		}
		delete(body, "reasoning_effort")
		delete(body, "thinking")
	}

	// Strip thinking blocks from conversation history if target is not Anthropic
	if targetSurface != contracts.SurfaceAnthropic {
		StripThinkingBlocks(body)
	}
}

// StripThinkingBlocks removes type: "thinking" and type: "redacted_thinking" content blocks from messages.
func StripThinkingBlocks(body map[string]any) {
	messages, ok := body["messages"].([]any)
	if !ok {
		return
	}
	for i := range messages {
		msgMap, ok := messages[i].(map[string]any)
		if !ok {
			continue
		}
		content, ok := msgMap["content"].([]any)
		if !ok {
			continue
		}
		var filtered []any
		for _, bRaw := range content {
			bMap, ok := bRaw.(map[string]any)
			if !ok {
				filtered = append(filtered, bRaw)
				continue
			}
			bType, _ := bMap["type"].(string)
			if bType == "thinking" || bType == "redacted_thinking" {
				continue
			}
			filtered = append(filtered, bRaw)
		}
		if len(filtered) == 0 {
			msgMap["content"] = ""
		} else {
			msgMap["content"] = filtered
		}
		messages[i] = msgMap
	}
	body["messages"] = messages
}
