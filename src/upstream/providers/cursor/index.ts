/**
 * Cursor CLI provider — routes to Cursor's AgentService via gRPC Connect
 * protocol over HTTP/2. Auth: OAuth access token stored as provider
 * credential (Bearer token).
 *
 * Each request is stateless (no conversation carry-over); the full
 * OpenAI Chat message history is serialized into the protobuf
 * ConversationState on every call.
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { cursorModelCatalog } from "./models";
import { buildCursorChatRequest, openCursorHttp2Stream, decodeCursorStream } from "./transport";
import type { ProxyTarget } from "../../proxy/types";

class CursorProvider implements Provider {
  readonly id = "cursor" as const;
  readonly display = {
    name: "Cursor CLI",
    icon: "cursor",
    authKind: "session" as const,
    authHint: "Paste your Cursor OAuth access token. Obtain it from Cursor's auth flow.",
  };
  readonly models = cursorModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    // Accept any model id — Cursor's server resolves the actual model.
    // "default" = server picks; otherwise it's a Cursor model id.
    return { provider: "cursor", modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Cursor CLI currently supports the OpenAI Chat shape.");
    }

    if (!credential.value) {
      throw new ProviderCallError(401, "authentication", "Cursor requires an OAuth access token.");
    }

    const modelId = target.modelId || "default";
    const body = request.body as Record<string, unknown>;

    // Build the gRPC Connect request
    const cursorReq = buildCursorChatRequest(credential.value, modelId, body);

    // Open HTTP/2 stream
    let response: Awaited<ReturnType<typeof openCursorHttp2Stream>>;
    try {
      response = await openCursorHttp2Stream(cursorReq, signal, proxy);
    } catch (err) {
      if (err instanceof ProviderCallError) throw err;
      throw new ProviderCallError(502, "unavailable", `Cursor connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stream is always streaming — Cursor's AgentService.Run is a server-streaming RPC
    return { type: "stream", events: decodeCursorStream(response) };
  }
}

export const cursorProvider = new CursorProvider();
