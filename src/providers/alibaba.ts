import { makeOpenAIAdapter, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

export const alibabaConfig = {
  id: "alibaba",
  displayName: "Alibaba Cloud / DashScope",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  credentialKind: "api_key",
  credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
} as const satisfies OpenAIAdapterConfig;

export const AlibabaAdapter = makeOpenAIAdapter(alibabaConfig);
