package adapters

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const antigravitySystemInstruction = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task.**Absolute paths only****Proactiveness**"

type antigravityWireProfile struct {
	ModelEnum       string
	MaxOutputTokens int
}

var antigravityWireProfiles = map[string]antigravityWireProfile{
	"gemini-3.5-flash-extra-low": {ModelEnum: "MODEL_PLACEHOLDER_M187", MaxOutputTokens: 65536},
	"gemini-3.5-flash-low":       {ModelEnum: "MODEL_PLACEHOLDER_M20", MaxOutputTokens: 65536},
	"gemini-3-flash-agent":       {ModelEnum: "MODEL_PLACEHOLDER_M132", MaxOutputTokens: 65536},
	"gemini-3.1-pro-low":         {ModelEnum: "MODEL_PLACEHOLDER_M36", MaxOutputTokens: 65535},
	"gemini-pro-agent":           {ModelEnum: "MODEL_PLACEHOLDER_M16", MaxOutputTokens: 65535},
	"claude-sonnet-4-6":          {MaxOutputTokens: 64000},
	"claude-opus-4-6-thinking":   {MaxOutputTokens: 64000},
}

// AntigravityAdapter translates OpenAI-shaped normalized requests into the
// Cloud Code Assist Gemini envelope used by Antigravity. It is deliberately
// separate from OpenAI because project identity, request IDs, labels, tool
// mode, and system instructions are provider policy, not generic wire behavior.
type AntigravityAdapter struct {
	meta    ProviderMeta
	caps    ProviderCaps
	catalog *staticCatalog
	baseURL string
}

// NewAntigravityAdapter creates a Cloud Code Assist adapter.
func NewAntigravityAdapter(cfg OpenAIAdapterConfig) *AntigravityAdapter {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://daily-cloudcode-pa.googleapis.com"
	}
	if cfg.ID == "" {
		cfg.ID = "antigravity"
	}
	if cfg.DisplayName == "" {
		cfg.DisplayName = "Antigravity"
	}
	if cfg.CredentialKind == "" {
		cfg.CredentialKind = CredentialOAuth
	}
	models := cfg.Models
	if models == nil {
		models = []ProviderModel{}
	}
	caps := aggregateCapabilities(models, ProviderCaps{Surfaces: []Surface{SurfaceOpenAIChat}, Streaming: true, Reasoning: true, ToolCalls: true, Images: true})
	return &AntigravityAdapter{
		meta: ProviderMeta{ID: cfg.ID, DisplayName: cfg.DisplayName, Protocol: ProtocolOpenAI, CredentialKind: cfg.CredentialKind, CredentialKinds: []CredentialKind{cfg.CredentialKind}, CredentialRef: cfg.CredentialRef, BaseURL: base, CredentialURL: cfg.CredentialURL},
		caps: caps, catalog: newStaticCatalog(models), baseURL: base,
	}
}

func (p *AntigravityAdapter) Metadata() ProviderMeta       { return p.meta }
func (p *AntigravityAdapter) Capabilities() ProviderCaps   { return p.caps }
func (p *AntigravityAdapter) Models() ProviderModelCatalog { return p.catalog }

func (p *AntigravityAdapter) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
	entry := p.catalog.Get(modelID)
	if entry == nil {
		return RouteTarget{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: modelID}
	}
	caps := p.caps
	if entry.Capabilities != nil {
		caps = *entry.Capabilities
	}
	if !containsSurface(caps.Surfaces, surface) {
		return RouteTarget{}, &UnknownSurfaceError{ProviderID: p.meta.ID, Surface: surface}
	}
	upstream := entry.UpstreamID
	if upstream == "" {
		upstream = entry.ID
	}
	return RouteTarget{ProviderID: p.meta.ID, ModelID: entry.ID, UpstreamModelID: upstream, Surface: surface}, nil
}

func (p *AntigravityAdapter) Endpoint(RouteTarget) Endpoint {
	return Endpoint{Method: http.MethodPost, Path: "v1internal:streamGenerateContent", Query: map[string]string{"alt": "sse"}}
}

func (p *AntigravityAdapter) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	if target.ProviderID != "" && target.ProviderID != p.meta.ID {
		return AuthMaterial{}, &IDMismatchError{AdapterID: p.meta.ID, TargetID: target.ProviderID}
	}
	var parsed struct {
		Token      string `json:"token"`
		ProjectID  string `json:"projectId"`
		ProjectID2 string `json:"project_id"`
	}
	if err := json.Unmarshal([]byte(credential), &parsed); err != nil || strings.TrimSpace(parsed.Token) == "" {
		return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "credentials must contain token and projectId"}
	}
	project := parsed.ProjectID
	if project == "" {
		project = parsed.ProjectID2
	}
	if strings.TrimSpace(project) == "" {
		return AuthMaterial{}, &AuthError{ProviderID: p.meta.ID, Reason: "credentials must contain projectId"}
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+parsed.Token)
	headers.Set("Content-Type", "application/json")
	headers.Set("Accept", "text/event-stream")
	headers.Set("User-Agent", "antigravity/hub/2.1.4 windows/amd64")
	return AuthMaterial{Headers: headers}, nil
}

func (p *AntigravityAdapter) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	target := envelope.Target
	entry := p.catalog.Get(target.ModelID)
	if entry == nil {
		return BuiltRequest{}, &UnknownModelError{ProviderID: p.meta.ID, ModelID: target.ModelID}
	}
	auth, err := p.AuthMaterial(credential, target)
	if err != nil {
		return BuiltRequest{}, err
	}
	var credentials struct {
		Token      string `json:"token"`
		ProjectID  string `json:"projectId"`
		ProjectID2 string `json:"project_id"`
	}
	if err := json.Unmarshal([]byte(credential), &credentials); err != nil {
		return BuiltRequest{}, &AuthError{ProviderID: p.meta.ID, Reason: "invalid credentials JSON"}
	}
	project := credentials.ProjectID
	if project == "" {
		project = credentials.ProjectID2
	}
	var input map[string]any
	if err := json.Unmarshal(envelope.Body, &input); err != nil || input == nil {
		return BuiltRequest{}, fmt.Errorf("providers/antigravity: request body must be a JSON object")
	}
	request := map[string]any{"contents": antigravityContents(input)}
	model := target.UpstreamModelID
	if model == "" {
		model = entry.ID
	}
	if system := antigravitySystem(input); system != "" || strings.Contains(strings.ToLower(target.ModelID), "claude") || strings.Contains(strings.ToLower(target.ModelID), "gemini-3") {
		parts := []map[string]any{{"text": antigravitySystemInstruction}}
		if system != "" {
			parts = append(parts, map[string]any{"text": system})
		}
		request["systemInstruction"] = map[string]any{"role": "user", "parts": parts}
	}
	if tools := antigravityTools(input); len(tools) > 0 {
		request["tools"] = []any{map[string]any{"functionDeclarations": tools}}
		request["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "VALIDATED"}}
	}
	profile := antigravityWireProfiles[model]
	if profile.MaxOutputTokens > 0 {
		request["generationConfig"] = map[string]any{"maxOutputTokens": profile.MaxOutputTokens}
	}
	sessionID := firstHeader(envelope.Headers, "session_id", "session-id", "x-session-id", "conversation_id", "conversation-id", "x-client-request-id")
	if sessionID == "" {
		sessionID = antigravityIdentifier("session:" + project + ":" + target.ModelID)
	}
	agentID := antigravityIdentifier("agent:" + project)
	trajectoryID := antigravityIdentifier("trajectory:" + sessionID)
	step := 2
	if rawStep := firstHeader(envelope.Headers, "x-antigravity-step", "last_step_index"); rawStep != "" {
		if parsed, parseErr := strconv.Atoi(rawStep); parseErr == nil && parsed >= 1 {
			step = parsed + 1
		}
	}
	requestID := "agent/" + agentID + "/" + fmt.Sprint(time.Now().UnixMilli()) + "/" + trajectoryID + "/" + strconv.Itoa(step)
	request["sessionId"] = sessionID
	request["labels"] = map[string]string{
		"trajectory_id":            trajectoryID,
		"last_step_index":          strconv.Itoa(step - 1),
		"used_claude":              fmt.Sprint(strings.Contains(strings.ToLower(target.ModelID), "claude")),
		"used_claude_conservative": fmt.Sprint(strings.Contains(strings.ToLower(target.ModelID), "claude")),
	}
	if profile.ModelEnum != "" {
		request["labels"].(map[string]string)["model_enum"] = profile.ModelEnum
	}
	payload := map[string]any{"project": project, "model": model, "request": request, "requestId": requestID, "requestType": "agent", "userAgent": "antigravity"}
	body, err := json.Marshal(payload)
	if err != nil {
		return BuiltRequest{}, fmt.Errorf("providers/antigravity: marshal request: %w", err)
	}
	return BuiltRequest{Endpoint: p.Endpoint(target), Body: body, Auth: auth, Stream: true}, nil
}

func antigravityIdentifier(seed string) string {
	return strings.TrimPrefix(codexIdentifier(seed), "pc_")
}

func antigravitySystem(input map[string]any) string {
	value, _ := input["system"].(string)
	return strings.TrimSpace(value)
}

func antigravityContents(input map[string]any) []map[string]any {
	messages, _ := input["messages"].([]any)
	contents := make([]map[string]any, 0, len(messages))
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		if role == "assistant" {
			role = "model"
		} else {
			role = "user"
		}
		parts := []map[string]any{}
		switch content := message["content"].(type) {
		case string:
			parts = append(parts, map[string]any{"text": content})
		case []any:
			for _, block := range content {
				if item, ok := block.(map[string]any); ok {
					if text, ok := item["text"].(string); ok && text != "" {
						parts = append(parts, map[string]any{"text": text})
					}
				}
			}
		}
		if len(parts) > 0 {
			contents = append(contents, map[string]any{"role": role, "parts": parts})
		}
	}
	return contents
}

func antigravityTools(input map[string]any) []map[string]any {
	raw, _ := input["tools"].([]any)
	tools := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := tool["function"].(map[string]any)
		if fn == nil {
			fn = tool
		}
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		declaration := map[string]any{"name": name, "description": fn["description"], "parameters": fn["parameters"]}
		tools = append(tools, declaration)
	}
	return tools
}

func (p *AntigravityAdapter) ClassifyResponse(statusCode int, body []byte) ClassifiedResponse {
	return classifyByStatus(statusCode, body)
}
