import { consoleRequest, isRecord } from "../api";
import type { ApiErrorShape } from "../api";
import type { StudioSessionView, StudioSessionSummary } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

function assertSession(value: unknown): StudioSessionView {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.messages)) {
    throw { status: 500, code: "invalid_response", message: "Invalid studio session response" } satisfies ApiErrorShape;
  }
  return value as unknown as StudioSessionView;
}

function assertSessionList(value: unknown): StudioSessionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw { status: 500, code: "invalid_response", message: "Invalid studio session list response" } satisfies ApiErrorShape;
  }
  return value.items as StudioSessionSummary[];
}

export interface StudioKeyResult {
  readonly key: string;
  readonly keyId: string;
  readonly prefix: string;
}

/** Lists playground sessions, newest first. */
export function useStudioSessions() {
  return useQuery({
    queryKey: queryKeys.studio.sessions,
    queryFn: (context) =>
      consoleRequest<unknown>("/studio/sessions", { signal: querySignal(context) }).then(
        assertSessionList,
      ),
    ...QUERY_OPTIONS,
  });
}

/** Loads one playground session with its transcript. */
export function useStudioSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.studio.session(sessionId ?? ""),
    queryFn: (context) => {
      if (!sessionId) throw { status: 400, code: "invalid_request", message: "Session is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(`/studio/sessions/${encodeURIComponent(sessionId)}`, {
        signal: querySignal(context),
      }).then(assertSession);
    },
    ...QUERY_OPTIONS,
    enabled: Boolean(sessionId),
  });
}

export interface StudioSessionCreateInput {
  readonly title?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
}

/** Creates a playground session. */
export function useCreateStudioSession() {
  const queryClient = useQueryClient();
  return useMutation<StudioSessionView, ApiErrorShape, StudioSessionCreateInput>({
    mutationFn: (input) =>
      consoleRequest<unknown>("/studio/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }).then(assertSession),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.studio.sessions });
    },
  });
}

export interface StudioSessionPatchInput {
  readonly sessionId: string;
  readonly title?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly messages?: unknown;
  readonly media?: unknown;
}

/** Patches title/model/system/transcript/media of one session. */
export function usePatchStudioSession() {
  const queryClient = useQueryClient();
  return useMutation<StudioSessionView, ApiErrorShape, StudioSessionPatchInput>({
    mutationFn: ({ sessionId, ...patch }) =>
      consoleRequest<unknown>(`/studio/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }).then(assertSession),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.studio.sessions }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.studio.session(variables.sessionId),
        }),
      ]);
    },
  });
}

/** Deletes one playground session. */
export function useDeleteStudioSession() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, { sessionId: string }>({
    mutationFn: ({ sessionId }) =>
      consoleRequest<{ success: boolean }>(`/studio/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.studio.sessions });
    },
  });
}

/**
 * Mints (first call) or re-issues the per-tenant Studio API key the page
 * uses to call `/v1/*` directly. The secret lives in sessionStorage, never
 * in the query cache — cached secrets would linger past sign-out.
 */
export function useStudioKey() {
  return useMutation<StudioKeyResult, ApiErrorShape, void>({
    mutationFn: () => consoleRequest<StudioKeyResult>("/studio/key", { method: "POST", body: "{}" }),
  });
}
