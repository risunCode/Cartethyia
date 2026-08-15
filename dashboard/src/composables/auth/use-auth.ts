import { useMutation, useQuery, useQueryClient, type QueryOptions } from "@tanstack/solid-query";
import {
  cancelOAuth,
  completeOAuth,
  getAuthSession,
  getOAuthState,
  loginAuth,
  logoutAuth,
  refreshAuthSession,
  refreshOAuth,
  startOAuth,
  type AuthSession,
  type LoginInput,
  type OAuthCompleteInput,
  type OAuthRefreshInput,
  type OAuthStartInput,
} from "./auth-api";

export const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;

/** Reads the daemon-owned browser session using same-origin credentials. */
export function useAuthSession(
  options: Omit<QueryOptions<AuthSession, Error, AuthSession, typeof AUTH_SESSION_QUERY_KEY>, "queryKey" | "queryFn" | "initialData"> = {},
) {
  return useQuery<AuthSession, Error, AuthSession, typeof AUTH_SESSION_QUERY_KEY>(() => ({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: getAuthSession,
    retry: false,
    ...options,
  }));
}

/** Mutates the daemon login endpoint and publishes the redacted session. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation(() => ({
    mutationFn: (input: LoginInput) => loginAuth(input),
    onSuccess: (session) => queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, session),
  }));
}

/** Refreshes the current daemon session without exposing session credentials to UI state. */
export function useRefreshSession() {
  const queryClient = useQueryClient();
  return useMutation(() => ({
    mutationFn: refreshAuthSession,
    onSuccess: (session) => queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, session),
  }));
}

/** Logs out and clears every protected query regardless of server outcome. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation(() => ({
    mutationFn: logoutAuth,
    onSettled: () => queryClient.clear(),
  }));
}

/** Starts an OAuth handshake through the daemon auth namespace. */
export function useOAuthStart() {
  return useMutation(() => ({ mutationFn: (input: OAuthStartInput) => startOAuth(input) }));
}

/** Polls a bounded OAuth state returned by the daemon. */
export function useOAuthSession(sessionId: string | null | undefined, options: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery(() => ({
    queryKey: ["auth", "oauth", sessionId] as const,
    queryFn: () => getOAuthState(sessionId ?? ""),
    enabled: Boolean(sessionId) && options.enabled !== false,
    refetchInterval: options.refetchInterval ?? 2_000,
    retry: false,
  }));
}

/** Completes an OAuth handshake; callers should clear code/state after every settled result. */
export function useOAuthComplete() {
  return useMutation(() => ({ mutationFn: ({ sessionId, input }: { sessionId: string; input: OAuthCompleteInput }) => completeOAuth(sessionId, input) }));
}

/** Cancels an OAuth handshake and leaves no credential material in the query cache. */
export function useOAuthCancel() {
  const queryClient = useQueryClient();
  return useMutation(() => ({
    mutationFn: (sessionId: string) => cancelOAuth(sessionId),
    onSettled: (_data, _error, sessionId) => {
      queryClient.removeQueries({ queryKey: ["auth", "oauth", sessionId] });
    },
  }));
}

/** Refreshes a provider OAuth account through the daemon auth namespace. */
export function useOAuthRefresh() {
  return useMutation(() => ({ mutationFn: (input: OAuthRefreshInput) => refreshOAuth(input) }));
}

export type { AuthSession, LoginInput, OAuthCompleteInput, OAuthRefreshInput, OAuthStartInput, OAuthState } from "./auth-api";
