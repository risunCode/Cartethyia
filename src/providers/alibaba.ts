import { makeNativeAdapter, type NativeProviderConfig } from "./shared";

export const alibabaConfig = {
  id: "alibaba",
  displayName: "Alibaba Cloud / DashScope",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  credentialKind: "api_key",
  credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
} as const satisfies NativeProviderConfig;

export const AlibabaAdapter = makeNativeAdapter(alibabaConfig);
