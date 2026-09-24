import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  ApiKeyResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ShareKeyResponse,
  ShareLinkResponse,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, assertApiKeys, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Creates an API key and refreshes the key list; the returned secret is one-time data. */
export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation<CreateApiKeyResponse, ApiErrorShape, CreateApiKeyRequest>({
    mutationFn: (request) =>
      consoleRequest<CreateApiKeyResponse>("/api-keys", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

/** Updates API-key limits or labels through the existing partial-update contract. */
export function useUpdateApiKey() {
  const queryClient = useQueryClient();
  return useMutation<
    ApiKeyResponse,
    ApiErrorShape,
    { keyId: string; request: Partial<CreateApiKeyRequest> }
  >({
    mutationFn: ({ keyId, request }) =>
      consoleRequest<ApiKeyResponse>(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

/** Revokes an API key and refreshes the key list. */
export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (keyId) =>
      consoleRequest<{ success: boolean }>(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

/** Mints a public share link for an API key; the bearer token is returned once. */
export function useShareApiKey() {
  const queryClient = useQueryClient();
  return useMutation<
    ShareKeyResponse,
    ApiErrorShape,
    { keyId: string; kind?: "monitor" | "setup"; expiresAt?: string | null }
  >({
    mutationFn: ({ keyId, ...body }) =>
      consoleRequest<ShareKeyResponse>(`/api-keys/${encodeURIComponent(keyId)}/share`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async (_result, { keyId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.shares(keyId) });
    },
  });
}

/** Lists a key's existing share links (never tokens); disabled without a selected key. */
export function useShareLinks(keyId: string | null) {
  return useQuery<ShareLinkResponse[], ApiErrorShape>({
    queryKey: queryKeys.apiKeys.shares(keyId ?? ""),
    queryFn: () =>
      consoleRequest<ShareLinkResponse[]>(
        `/api-keys/${encodeURIComponent(keyId ?? "")}/shares`,
      ),
    enabled: keyId !== null,
  });
}

/** Revokes one share link and refreshes that key's share list. */
export function useRevokeShareLink() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, { keyId: string; shareId: string }>({
    mutationFn: ({ keyId, shareId }) =>
      consoleRequest<{ success: boolean }>(
        `/api-keys/${encodeURIComponent(keyId)}/shares/${encodeURIComponent(shareId)}`,
        { method: "DELETE" },
      ),
    onSuccess: async (_result, { keyId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.shares(keyId) });
    },
  });
}

/** Loads tenant API-key metadata; secrets are never returned by this query. */
export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/api-keys", { signal: querySignal(context) }).then(assertApiKeys),
    ...QUERY_OPTIONS,
  });
}

