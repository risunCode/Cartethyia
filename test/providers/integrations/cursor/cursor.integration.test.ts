import { describe, expect, test } from "bun:test";
import { CURSOR_LOGIN_URL, CURSOR_POLL_URL, CURSOR_REFRESH_URL, CursorOAuthClient, encodeCursorCredential, extractCursorAccessTokenUserId, generateCursorAuthParams, getCursorTokenExpiry, isCursorTokenExpiringSoon, parseCursorCredential } from "../../../../src/providers/integrations/cursor/cursor-oauth";
import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, AgentServerMessageSchema } from "../../../../src/providers/integrations/cursor/generated/agent_pb";
import { CURSOR_MODELS, buildCursorHeaders, buildCursorRunRequest, fetchCursorModels, parseCursorModelsPayload } from "../../../../src/providers/integrations/cursor/cursor";
import { CONNECT_COMPRESSED_FLAG, frameConnectMessage } from "../../../../src/providers/integrations/connect";
import type { CanonicalMessage } from "../../../../src/transport/canonical-model";
import { jsonResponse } from "../../../helpers/sse-fixtures";
import { providerUsesBespokeWire } from "../../../../src/providers/provider-metadata";

describe("Cursor Integration", () => {
  describe("cursor-oauth.test.ts", () => {
function jwt(exp: number, sub = "auth0|user-1"): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp, sub })}.sig`;
}


describe("Cursor OAuth params", () => {
  test("builds the loginDeepControl URL with PKCE challenge and uuid", async () => {
    const params = await generateCursorAuthParams();
    expect(params.loginUrl.startsWith(`${CURSOR_LOGIN_URL}?`)).toBe(true);
    const url = new URL(params.loginUrl);
    expect(url.searchParams.get("challenge")).toBe(params.challenge);
    expect(url.searchParams.get("uuid")).toBe(params.uuid);
    expect(url.searchParams.get("mode")).toBe("login");
    expect(url.searchParams.get("redirectTarget")).toBe("cli");
  });

  test("extracts the user id from JWT sub claims", () => {
    expect(
      extractCursorAccessTokenUserId(jwt(Math.floor(Date.now() / 1000) + 3600)),
    ).toBe("user-1");
    expect(extractCursorAccessTokenUserId("opaque-token")).toBeUndefined();
  });

  test("computes expiry with skew and detects expiring tokens", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(getCursorTokenExpiry(jwt(future))).toBe(future * 1000 - 5 * 60 * 1000);
    expect(isCursorTokenExpiringSoon(jwt(future))).toBe(false);
    expect(isCursorTokenExpiringSoon(jwt(Math.floor(Date.now() / 1000) + 60))).toBe(true);
    expect(isCursorTokenExpiringSoon("opaque-token")).toBe(true);
  });

  test("credential envelope round-trips and tolerates raw tokens", () => {
    const encoded = encodeCursorCredential("access-1", "refresh-1", new Date(1_700_000_000_000));
    const parsed = parseCursorCredential(encoded);
    expect(parsed).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(parseCursorCredential("raw-token")).toMatchObject({
      accessToken: "raw-token",
      refreshToken: "raw-token",
    });
  });
});

describe("Cursor device flow", () => {
  test("start returns the login URL and private PKCE state", async () => {
    const client = new CursorOAuthClient();
    const started = await client.startDeviceAuth({
      providerId: "cursor",
      tenantId: null,
      accountLabel: "cursor",
    });
    expect(started.verificationUri.startsWith(`${CURSOR_LOGIN_URL}?`)).toBe(true);
    expect(started.providerState).toBeString();
    const state = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    expect(typeof state.verifier).toBe("string");
    expect(state.uuid).toBe(started.deviceAuthId);
  });

  test("poll maps 404 to pending, tokens to complete, errors to failed", async () => {
    const access = jwt(Math.floor(Date.now() / 1000) + 3600);
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response("not found", { status: 404 });
      if (calls.length === 2) return jsonResponse({ accessToken: access, refreshToken: "r-1" });
      return jsonResponse({ error: "boom" }, 500);
    }) as unknown as typeof fetch;
    const client = new CursorOAuthClient(fetcher);
    const context = {
      providerId: "cursor",
      tenantId: null,
      accountLabel: "cursor",
      providerState: JSON.stringify({ verifier: "v-1", uuid: "u-1" }),
    };
    expect(await client.pollDeviceAuth("u-1", context)).toEqual({ status: "pending" });
    const complete = await client.pollDeviceAuth("u-1", context);
    expect(complete).toMatchObject({
      status: "complete",
      result: { access, refresh: "r-1", accountLabel: "user-1" },
    });
    expect(calls[1]).toBe(`${CURSOR_POLL_URL}?uuid=u-1&verifier=v-1`);
    const failed = await client.pollDeviceAuth("u-1", context);
    expect(failed.status).toBe("failed");
    expect(await client.pollDeviceAuth("u-1")).toMatchObject({ status: "failed" });
  });

  test("refresh posts the bearer token with an empty JSON body", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const access = jwt(Math.floor(Date.now() / 1000) + 3600);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      seenBody = String(init?.body ?? "");
      return jsonResponse({ accessToken: access, refreshToken: "r-2" });
    }) as unknown as typeof fetch;
    const client = new CursorOAuthClient(fetcher);
    const result = await client.refresh(
      encodeCursorCredential("old-access", "old-refresh"),
    );
    expect(seenUrl).toBe(CURSOR_REFRESH_URL);
    expect(seenAuth).toBe("Bearer old-refresh");
    expect(seenBody).toBe("{}");
    expect(result).toMatchObject({ access, refresh: "r-2" });
  });
});
  });

  describe("cursor.test.ts", () => {
const messages: CanonicalMessage[] = [
  { role: "user", content: [{ kind: "text", text: "hello" }] },
];

function extractUserMessageRun(bytes: Uint8Array) {
  const decoded = fromBinary(AgentClientMessageSchema, bytes);
  if (decoded.message.case !== "runRequest") throw new Error("expected runRequest");
  const action = decoded.message.value.action;
  if (action?.action.case !== "userMessageAction") throw new Error("expected userMessageAction");
  return action.action.value.userMessage;
}

describe("Cursor request framing", () => {
  test("builds a decodable Run request for the requested model", () => {
    const bytes = buildCursorRunRequest(messages, "claude-4.5-sonnet");
    const decoded = fromBinary(AgentClientMessageSchema, bytes);
    if (decoded.message.case !== "runRequest") throw new Error("expected runRequest");
    expect(decoded.message.value.requestedModel?.modelId).toBe("claude-4.5-sonnet");
    expect(decoded.message.value.modelDetails?.modelId).toBe("claude-4.5-sonnet");
  });

  test("embeds images from the last user message into selected_context", () => {
    const imageMessages: CanonicalMessage[] = [
      { role: "user", content: [
        { kind: "text", text: "describe this" },
        { kind: "image", payload: { data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
      ]},
    ];
    const userMessage = extractUserMessageRun(buildCursorRunRequest(imageMessages, "default"));
    expect(userMessage?.selectedContext?.selectedImages.length).toBe(1);
    expect(userMessage?.selectedContext?.selectedImages[0]?.mimeType).toBe("image/png");
  });

  test("Connect frames round-trip with 5-byte envelopes", () => {
    const payload = new TextEncoder().encode("ping");
    const framed = frameConnectMessage(payload);
    expect(framed[0]).toBe(0);
    expect(new DataView(framed.buffer, framed.byteOffset + 1, 4).getUint32(0, false)).toBe(
      payload.length,
    );
    expect(parseCursorModelsPayload(framed)).toEqual(payload);
  });

  test("gzip Connect envelopes decompress", () => {
    const payload = new TextEncoder().encode("x".repeat(100));
    const framed = frameConnectMessage(gzipSync(payload), CONNECT_COMPRESSED_FLAG);
    expect(parseCursorModelsPayload(framed)).toEqual(payload);
  });

  test("server text deltas decode through the generated schema", () => {
    const server = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: { message: { case: "textDelta", value: { text: "hi" } } },
      },
    });
    const bytes = toBinary(AgentServerMessageSchema, server);
    const back = fromBinary(AgentServerMessageSchema, bytes);
    if (back.message.case !== "interactionUpdate") throw new Error("expected update");
    expect(back.message.value.message.case).toBe("textDelta");
  });
});

describe("Cursor headers and catalog", () => {
  test("sends Connect proto headers with ghost mode and CLI identity", () => {
    const headers = buildCursorHeaders("token-1");
    expect(headers).toMatchObject({
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: "Bearer token-1",
      "x-ghost-mode": "true",
      "x-cursor-client-type": "cli",
    });
    expect(typeof headers["x-request-id"]).toBe("string");
  });

  test("static catalog covers the reference models", () => {
    const ids = CURSOR_MODELS.map((model) => model.modelId);
    for (const id of [
      "default",
      "claude-4.5-opus-high",
      "claude-4.5-sonnet",
      "claude-4.6-opus-high",
      "claude-4.6-sonnet-medium",
      "composer-2.5",
      "composer-2.5-fast",
    ]) {
      expect(ids).toContain(id);
    }
    for (const model of CURSOR_MODELS) {
      // Cursor's adapter frames Connect+protobuf itself and ignores the wire
      // family, so the row carries an inert canonical value; the RPC path and
      // the provider's bespoke declaration are what the router acts on.
      expect(model.endpointPath).toBe("/agent.v1.AgentService/Run");
    }
    expect(providerUsesBespokeWire("cursor")).toBe(true);
  });

  test("live discovery returns null for empty credentials without network", async () => {
    await expect(fetchCursorModels("")).resolves.toBeNull();
  });
});
  });

});
