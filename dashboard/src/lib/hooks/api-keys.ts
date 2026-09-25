import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ShareKeyResponse,
  SharedKeySummary,
  SharedKeyActivityDetail,
  UpdateApiKeyResponse,
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
    UpdateApiKeyResponse,
    ApiErrorShape,
    { keyId: string; request: Partial<CreateApiKeyRequest> }
  >({
    mutationFn: ({ keyId, request }) =>
      consoleRequest<UpdateApiKeyResponse>(`/api-keys/${encodeURIComponent(keyId)}`, {
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

/**
 * Loads the key's stable link, or null when it has none yet. Never rotates:
 * the console shows one link that stays put until the operator regenerates it.
 */
export function useShareLink(keyId: string | null) {
  return useQuery({
    queryKey: queryKeys.apiKeys.shareLink(keyId ?? ""),
    queryFn: (context) =>
      consoleRequest<ShareKeyResponse | null>(
        `/api-keys/${encodeURIComponent(keyId ?? "")}/share`,
        { signal: querySignal(context) },
      ),
    enabled: keyId !== null,
  });
}

/** Establishes the key's link, or rotates it when `regenerate` is set. */
export function useShareApiKey() {
  const queryClient = useQueryClient();
  return useMutation<
    ShareKeyResponse,
    ApiErrorShape,
    { keyId: string; expiresAt?: string | null; regenerate?: boolean }
  >({
    mutationFn: ({ keyId, ...body }) =>
      consoleRequest<ShareKeyResponse>(`/api-keys/${encodeURIComponent(keyId)}/share`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async (_result, { keyId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.shareLink(keyId) });
    },
  });
}

/** Rotates a personal key's credential and re-points its handoff link. */
export function useRegenerateApiKey() {
  const queryClient = useQueryClient();
  return useMutation<
    { secret: string; share: ShareKeyResponse | null },
    ApiErrorShape,
    { keyId: string }
  >({
    mutationFn: ({ keyId }) =>
      consoleRequest<{ secret: string; share: ShareKeyResponse | null }>(
        `/api-keys/${encodeURIComponent(keyId)}/regenerate`,
        { method: "POST" },
      ),
    onSuccess: async (_result, { keyId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.shareLink(keyId) });
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

/** Lists child credentials and safe usage aggregates for one share template. */
export function useSharedKeys(parentKeyId: string | null) {
  return useQuery({
    queryKey: queryKeys.apiKeys.sharedKeys(parentKeyId ?? ""),
    queryFn: (context) =>
      consoleRequest<SharedKeySummary[]>(
        `/api-keys/${encodeURIComponent(parentKeyId ?? "")}/shared-keys`,
        { signal: querySignal(context) },
      ),
    enabled: parentKeyId !== null,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/** Loads a child's top model aggregates and recent safe request metadata. */
export function useSharedKeyActivity(parentKeyId: string | null, childKeyId: string | null) {
  return useQuery({
    queryKey: queryKeys.apiKeys.sharedKeyActivity(parentKeyId ?? "", childKeyId ?? ""),
    queryFn: (context) =>
      consoleRequest<SharedKeyActivityDetail>(
        `/api-keys/${encodeURIComponent(parentKeyId ?? "")}/shared-keys/${encodeURIComponent(childKeyId ?? "")}/activity`,
        { signal: querySignal(context) },
      ),
    enabled: parentKeyId !== null && childKeyId !== null,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/** Revokes a child credential, invalidating its parent's live summary. */
export function useRevokeSharedKey() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, { parentKeyId: string; childKeyId: string }>({
    mutationFn: ({ childKeyId }) =>
      consoleRequest<{ success: boolean }>(`/api-keys/${encodeURIComponent(childKeyId)}`, { method: "DELETE" }),
    onSuccess: async (_result, { parentKeyId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.sharedKeys(parentKeyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

