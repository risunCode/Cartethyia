package builtin

import "github.com/cartethyia/daemon/internal/providers"

func Definitions() []providers.ProviderDefinition {
	definitions := []providers.ProviderDefinition{
		OpenAI(), AnthropicAI(), AIMLAPI(), Alibaba(), AlibabaCodingPlan(), AlibabaTokenPlan(),
		Baseten(), BlackboxAI(), Cerebras(), CodeBuddy(), CodeBuddyCN(), CoreWeave(), DeepSeek(),
		FirePass(), Fireworks(), GitHubCopilot(), Groq(), HuggingFace(), Kilo(), KimiCode(),
		LiteLLM(), LMStudio(), Meta(), MiniMax(), MiniMaxCode(), MiniMaxCodeCN(), Mistral(),
		Moonshot(), NanoGPT(), Novita(), NVIDIA(), Ollama(), OllamaCloud(), OpenCodeFree(),
		OpenCodeZen(), OpenCodeGo(), OpenRouter(), Qianfan(), QwenPortal(), SiliconFlow(),
		SiliconFlowCN(), Synthetic(), Together(), Umans(), Venice(), VercelAIGateway(), VLLM(),
		WaferServerless(), XAI(), XiaomiPAYG(), XiaomiTP(), ZAI(), ZenMux(), ZhipuCodingPlan(),
	}
	for i := range definitions {
		definitions[i] = providers.CompleteDefinition(definitions[i])
	}
	return definitions
}
