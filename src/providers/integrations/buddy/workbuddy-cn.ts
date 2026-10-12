// WorkBuddy CN uses the WorkBuddy contract on its China domain.
import { BuddyMediaAdapter } from "./buddy-media";
import type { ProviderAdapter } from "../../contracts";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import type { ModelDefinition } from "../../model-definition";
import { providerBaseUrl } from "../../metadata";
import { getWorkBuddyCnClientVersion } from "../../operations/client-versions";
import { BUDDY_INTL_MODELS_PATH, fetchBuddyDirectoryModels } from "./buddy-discovery-shared";
import { CODEBUDDY_CN_MODELS } from "./codebuddy-cn";
import { workbuddyPrePayload, WORKBUDDY_SYSTEM_PROMPT } from "./workbuddy";
import { workbuddyAdapterConfig, workbuddyHeaders, WORKBUDDY_CHAT_PATH } from "./workbuddy-shared";

export const WORKBUDDY_CN_PROVIDER_ID = "workbuddycn" as const;
export const WORKBUDDY_CN_DOMAIN = "www.workbuddy.cn" as const;
export const WORKBUDDY_CN_BASE_URL = providerBaseUrl(WORKBUDDY_CN_PROVIDER_ID);

export const WORKBUDDY_CN_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_CN_MODELS.map((model) => ({
    ...model,
    endpointPath: WORKBUDDY_CHAT_PATH,
  })),
];

export async function discoverWorkBuddyCnModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: WORKBUDDY_CN_BASE_URL,
    providerId: WORKBUDDY_CN_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_INTL_MODELS_PATH,
    endpoint: WORKBUDDY_CHAT_PATH,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

export function createWorkBuddyCnAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new BuddyMediaAdapter(
    workbuddyAdapterConfig({
      providerId: WORKBUDDY_CN_PROVIDER_ID,
      baseUrl: WORKBUDDY_CN_BASE_URL,
      domain: WORKBUDDY_CN_DOMAIN,
      prePayload: workbuddyPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    {
      variant: "IDE",
      systemPrompt: WORKBUDDY_SYSTEM_PROMPT,
      baseUrl: WORKBUDDY_CN_BASE_URL,
      buildHeaders: (context) =>
        workbuddyHeaders(context, undefined, WORKBUDDY_CN_DOMAIN, getWorkBuddyCnClientVersion()),
    },
  );
}
