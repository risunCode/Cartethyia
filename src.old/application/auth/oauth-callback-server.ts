/**
 * Local OAuth callback server — listens on provider-specific localhost ports
 * to catch the redirect after the user completes authorization in their
 * browser. When the redirect arrives, it extracts the code/state/error and
 * forwards them to the session manager's `complete()` flow.
 *
 * This replaces the callback server that the old `TokenKeeper` ran inline.
 */
import type { OAuthLoginSessionManager, OAuthCompleteSessionInput } from "./oauth-sessions";

// ---------------------------------------------------------------------------
// Provider → callback port/path mapping
// ---------------------------------------------------------------------------

interface CallbackEndpoint {
  readonly port: number;
  readonly path: string;
}

/**
 * Maps an OAuth provider id to its local callback endpoint.
 * Providers not listed here (device-flow only, etc.) have no callback server.
 */
function callbackEndpointFor(providerId: string): CallbackEndpoint | null {
  switch (providerId) {
    case "codex":
      return { port: 1455, path: "/auth/callback" };
    case "claude":
      return { port: 54545, path: "/callback" };
    case "antigravity":
      return { port: 51121, path: "/oauth-callback" };
    case "clinepass":
      // ClinePass uses a browser-based flow through the extension popup.
      // No local server needed — the redirect goes through the extension.
      return null;
    case "kimchi":
      return { port: 1457, path: "/callback" };
    default:
      return null;
  }
}

/**
 * Returns the default `redirectUri` for a provider, or `undefined` when the
 * provider doesn't use a local callback server.
 */
export function defaultRedirectUriForProvider(providerId: string): string | undefined {
  const endpoint = callbackEndpointFor(providerId);
  if (endpoint === null) return undefined;
  return `http://127.0.0.1:${endpoint.port}${endpoint.path}`;
}

// ---------------------------------------------------------------------------
// Server manager — one Bun.serve per port, shared across sessions
// ---------------------------------------------------------------------------

/** Opaque handle returned by Bun.serve — we only call .stop(). */
interface CallbackServer {
  stop(): void;
}

interface CallbackServerEntry {
  readonly server: CallbackServer;
  /** Session lookup by the exact state parameter (for callback matching). */
  readonly stateToSession: Map<string, { providerId: string; sessionId: string }>;
  /** All active sessions on this port, used for lifecycle cleanup. */
  readonly activeSessions: Map<string, { providerId: string; sessionId: string }>;
}

const servers = new Map<number, CallbackServerEntry>();
const logPrefix = "oauth_callback";

/** Sensitive substrings that must never appear in OAuth callback logs. */
const REDACT_PATTERNS = [
  /access_token[=:]\s*[^\s&"']+/gi,
  /refresh_token[=:]\s*[^\s&"']+/gi,
  /code[=:]\s*[^\s&"']+/gi,
  /bearer\s+[a-z0-9._\-]+/gi,
  /sk-[a-z0-9]{20,}/gi,
  /pt-[a-z0-9]{20,}/gi,
];

function redactDetail(detail: string): string {
  let redacted = detail;
  for (const pattern of REDACT_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function log(level: "info" | "warn", event: string, detail: string): void {
  const ts = new Date().toISOString();
  const tag = level === "warn" ? "[WARN]" : "[INFO]";
  console.log(`${ts} ${tag} [${logPrefix}] ${event} ${redactDetail(detail)}`);
}

function ensureCallbackServer(
  providerId: string,
  sessionId: string,
  state: string,
  sessionManager: OAuthLoginSessionManager,
  onComplete: OnComplete,
): void {
  const endpoint = callbackEndpointFor(providerId);
  if (endpoint === null) return;

  const existing = servers.get(endpoint.port);
  if (existing !== undefined) {
    existing.stateToSession.set(state, { providerId, sessionId });
    existing.activeSessions.set(sessionId, { providerId, sessionId });
    return;
  }

  const stateToSession = new Map<string, { providerId: string; sessionId: string }>();
  stateToSession.set(state, { providerId, sessionId });
  const activeSessions = new Map<string, { providerId: string; sessionId: string }>();
  activeSessions.set(sessionId, { providerId, sessionId });

  try {
    const server: CallbackServer = Bun.serve({
      hostname: "127.0.0.1",
      port: endpoint.port,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== endpoint.path) {
          return new Response("Not found", { status: 404 });
        }

        const stateParam = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        // State is mandatory. Never route a callback to an arbitrary waiting
        // session when a provider omits or alters the CSRF binding.
        if (stateParam === null || stateParam.length === 0) {
          return new Response("OAuth session not found or expired.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        const matched = stateToSession.get(stateParam);
        if (matched === undefined) {
          return new Response("OAuth session not found or expired.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        try {
          // Pass the full callback URL as `value` so the session manager
          // can parse provider-specific params (e.g. Kimchi's `token=`).
          const fullUrl = `http://127.0.0.1:${endpoint.port}${endpoint.path}${url.search}`;
          const input: OAuthCompleteSessionInput = error
            ? { error, state: stateParam }
            : { value: fullUrl, state: stateParam };

          await onComplete(matched.sessionId, input);
          activeSessions.delete(matched.sessionId);
          stateToSession.delete(stateParam);
          return new Response("OAuth login completed. You can close this tab.", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : "OAuth login failed";
          log("warn", "exchange_failed", `provider=${providerId} session=${matched.sessionId} error=${message}`);
          activeSessions.delete(matched.sessionId);
          stateToSession.delete(stateParam);
          return new Response("OAuth login failed. Return to the application and try again.", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      },
    });

    servers.set(endpoint.port, { server, stateToSession, activeSessions });
    log("info", "callback_ready", `provider=${providerId} port=${endpoint.port} path=${endpoint.path} session=${sessionId}`);
  } catch {
    log("warn", "callback_failed", `provider=${providerId} port=${endpoint.port} reason=port_unavailable`);
  }
}

/** Callback invoked when the callback server catches a redirect and the
 *  session manager successfully exchanges the code. The service layer
 *  implements this to persist the account and token. */
type OnComplete = (sessionId: string, input: OAuthCompleteSessionInput) => Promise<void>;

/**
 * Register a session for callback listening. Called when an OAuth login
 * session starts and the provider uses a local callback server.
 * `state` is the PKCE state embedded in the authorization URL.
 * `onComplete` is called after a successful exchange to persist the account.
 */
export function registerOAuthCallback(
  providerId: string,
  sessionId: string,
  state: string,
  sessionManager: OAuthLoginSessionManager,
  onComplete: OnComplete,
): void {
  ensureCallbackServer(providerId, sessionId, state, sessionManager, onComplete);
}

/**
 * Unregister a session from callback listening (e.g. when the session
 * completes, cancels, or expires). Shuts down the server when no sessions
 * remain on that port.
 */
export function unregisterOAuthCallback(providerId: string, sessionId: string): void {
  const endpoint = callbackEndpointFor(providerId);
  if (endpoint === null) return;

  const entry = servers.get(endpoint.port);
  if (entry === undefined) return;

  entry.activeSessions.delete(sessionId);

  if (entry.activeSessions.size === 0) {
    entry.server.stop();
    servers.delete(endpoint.port);
    log("info", "callback_stopped", `provider=${providerId} port=${endpoint.port}`);
  }
}
