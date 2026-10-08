/**
 * Routed web-search fallback for chat clients.
 *
 * A client that declares a hosted `web_search` tool expects the selected route
 * to execute it. When that route can, it must keep doing so — the fallback is
 * not a shortcut around a working native search. When it cannot, the search is
 * served by a configured search provider and injected into the conversation, so
 * the selected model still writes the answer instead of reporting that it
 * cannot browse.
 *
 * These are the three contracts that matter to a client and are each easy to
 * break in the wrong direction:
 *
 * - a search-capable selected route stays first and keeps its native tool;
 * - an incapable selected route receives the configured provider's results,
 *   and the chat adapter still sees the selected route's model;
 * - a configured provider that fails advances to the next configured one, and
 *   an exhausted fallback never fails the chat turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { RoutingEngine } from "../../src/transport/routing/router";
import { GatewayError } from "../../src/transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";
import {
  extractWebSearchInvocation,
  isWebSearchTool,
  isWebSearchToolName,
} from "../../src/transport/translation/capabilities";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

/** A Messages request that declares Anthropic's hosted web-search tool. */
function messagesSearchRequest(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "Coba cari siapa itu risuncode" }],
  };
}

/** A minimal chat candidate; only the fields routing reads are meaningful. */
function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: { tools: true },
    ...overrides,
  } as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return { revision: 1, candidates, aliases: {}, combos: {}, created_at: Date.now() };
}

describe("RoutingEngine web-search planning", () => {
  const engine = new RoutingEngine();

  test("a search-capable selected route is marked native and stays first", async () => {
    const capable = candidate({
      provider_id: "claude",
      model_id: "claude-opus-5",
      capability_profile: { tools: true, webSearch: true },
    });
    const fallback = candidate({
      provider_id: "exa",
      model_id: "exa-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const plan = await engine.plan("claude/claude-opus-5", snapshot([capable, fallback]), null, [], false, undefined, true);
    expect(plan.candidates[0]?.provider_id).toBe("claude");
    expect(plan.candidates[0]?.search_route).toBe("native");
    expect(plan.candidates[1]?.search_route).toBe("fallback");
  });

  test("an incapable selected route stays first and gets configured fallbacks", async () => {
    const incapable = candidate({ provider_id: "p", model_id: "m", capability_profile: { tools: true } });
    const exa = candidate({
      provider_id: "exa",
      model_id: "exa-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const codex = candidate({
      provider_id: "codex",
      model_id: "codex-search",
      service_kind: "websearch",
      capability_profile: { webSearch: true },
    });
    const plan = await engine.plan("p/m", snapshot([incapable, codex, exa]), null, [], false, undefined, true);
    expect(plan.candidates[0]?.provider_id).toBe("p");
    expect(plan.candidates[0]?.search_route).toBeUndefined();
    expect(plan.candidates.slice(1).map((item) => item.provider_id)).toEqual(["exa", "codex"]);
  });

  test("no configured provider leaves the request on its original route", async () => {
    const incapable = candidate({ provider_id: "p", model_id: "m", capability_profile: { tools: true } });
    const plan = await engine.plan("p/m", snapshot([incapable]), null, [], false, undefined, true);
    expect(plan.candidates.map((item) => item.provider_id)).toEqual(["p"]);
  });
});

dbDescribe("web-search fallback dispatch", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  /** Registers the selected route as search-incapable, plus a search provider. */
  function routesWithSearchProvider(
    overrides: { readonly capabilities?: Readonly<Record<string, boolean>> } = {},
  ): void {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: overrides.capabilities ?? { tools: true, webSearch: false },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
  }

  test("a search-capable route keeps the native tool and is not rewritten", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
    ]);
    let seen: CanonicalRequest | undefined;
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        seen = record.request;
      },
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(seen?.tools?.some((tool) => tool.name === "web_search")).toBe(true);
    expect(seen?.messages.length).toBe(1);
  });

  test("an incapable route answers from the configured search provider's results", async () => {
    routesWithSearchProvider();
    let seen: CanonicalRequest | undefined;
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        seen = record.request;
      },
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "risuncode is a developer" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // The search ran on the configured provider, with the caller's query.
    expect(searchAdapter.searches).toEqual(["Coba cari siapa itu risuncode"]);
    // The selected route still answers, now with the results in context. They
    // arrive as a completed tool-call + tool-result round: Claude Code counts
    // a search by the `web_search_tool_result` block in the response, so
    // plain user text reported "Did 0 searches" beside a correct answer.
    expect(seen?.model).toBe(world.modelId);
    expect(seen?.tools === undefined || seen.tools.length === 0).toBe(true);
    // The round the client sees: an assistant search call answered by its result.
    const callTurn = seen?.messages.at(-2);
    const resultTurn = seen?.messages.at(-1);
    expect(callTurn?.role).toBe("assistant");
    const call = callTurn?.content.find((part) => part.kind === "toolCall");
    expect(call !== undefined).toBe(true);
    expect(resultTurn?.role).toBe("user");
    const toolResult = resultTurn?.content.find((part) => part.kind === "toolResult");
    expect(toolResult !== undefined).toBe(true);
    if (toolResult?.kind === "toolResult") {
      expect(JSON.stringify(toolResult.content)).toContain("https://example.com/risuncode");
    }
    // The round closes on itself: one call, one result, matching ids.
    if (call?.kind === "toolCall" && toolResult?.kind === "toolResult") {
      expect(toolResult.call_id).toBe(call.call_id);
    }
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("risuncode is a developer"))).toBe(true);
  });

  test("a failing configured provider advances to the next configured one", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: false },
      },
      {
        providerId: "codex",
        modelId: "codex-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "answered" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    gateway.adapter("codex", {
      failSearchWith: () =>
        new GatewayError("platform_unavailable", 502, "codex search unreachable"),
    });
    const exa = gateway.adapter("exa", {
      searchResults: [{ title: "exa hit", url: "https://example.com/exa", snippet: "Snippet" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(exa.searches).toEqual(["Coba cari siapa itu risuncode"]);
  });

  test("an exhausted fallback still completes the chat turn", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: false },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => [
        { type: "message_start", sequence_number: 0, model: request.model },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "no search needed" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    gateway.adapter("exa", {
      failSearchWith: () => new GatewayError("platform_unavailable", 502, "exa unreachable"),
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("no search needed"))).toBe(true);
  });

  test("a native route that answers without searching is re-dispatched with the fallback results", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    // The route is marked native, so it is trusted first — and answers from its
    // own weights with no source at all. That is exactly what a client reports
    // as "Did 0 searches".
    let attempts = 0;
    const seen: CanonicalRequest[] = [];
    gateway.adapter(world.providerId, {
      onDispatch: (record) => {
        seen.push(record.request);
      },
      events: (request): readonly CanonicalEvent[] => {
        attempts += 1;
        return [
          { type: "message_start", sequence_number: 0, model: request.model },
          {
            type: "content_delta",
            sequence_number: 1,
            content: { kind: "text", text: attempts === 1 ? "I have no browsing ability" : "risuncode is a developer" },
          },
          { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
        ];
      },
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // The fallback ran, and the route was dispatched again with the hits.
    expect(searchAdapter.searches).toEqual(["Coba cari siapa itu risuncode"]);
    expect(attempts).toBe(2);
    // The second dispatch carries the results; the first did not.
    expect(JSON.stringify(seen[0]?.messages ?? [])).not.toContain("github.com/risunCode");
    expect(JSON.stringify(seen[1]?.messages ?? [])).toContain("github.com/risunCode");
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("risuncode is a developer"))).toBe(true);
  });

  test("a native route that really searched is not re-dispatched", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { tools: true, webSearch: true },
      },
      {
        providerId: "exa",
        modelId: "exa-search",
        accountId: world.accountId,
        serviceKind: "websearch",
        capabilities: { webSearch: true },
      },
    ]);
    let attempts = 0;
    gateway.adapter(world.providerId, {
      events: (request): readonly CanonicalEvent[] => {
        attempts += 1;
        return [
          { type: "message_start", sequence_number: 0, model: request.model },
          // An inline citation is search evidence: the upstream really looked.
          {
            type: "content_delta",
            sequence_number: 1,
            content: { kind: "text", text: "risuncode is at https://github.com/risunCode" },
          },
          { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
        ];
      },
    });
    const searchAdapter = gateway.adapter("exa", {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // Native search worked: no fallback, no second dispatch.
    expect(attempts).toBe(1);
    expect(searchAdapter.searches).toEqual([]);
  });
});

describe("search query extraction", () => {
  test("strips injected system-reminder scaffolding from a derived query", () => {
    // Reproduces a production failure: Claude Code appended its CLAUDE.md
    // (about CodeGraph) to the operator's turn, the whole turn became the
    // search query, and Exa returned pages about CodeGraph instead of the
    // subject the operator actually asked about.
    const request = {
      model: "m",
      source_surface: "messages",
      generation_controls: {},
      tools: [{ name: "web_search", native_type: "web_search_20250305" }],
      messages: [
        {
          role: "user",
          content: [
            {
              kind: "text",
              text:
                "coba kau websearch siapa itu risuncode\n" +
                "<system-reminder>\n" +
                "As you answer, you must use the codegraph tool.\n" +
                "# CLAUDE.md\n" +
                "Contents of CLAUDE.md about CodeGraph and AGENTS.md.\n" +
                "</system-reminder>",
            },
          ],
        },
      ],
    } as unknown as CanonicalRequest;
    const invocation = extractWebSearchInvocation(request);
    expect(invocation?.query).toBe("coba kau websearch siapa itu risuncode");
    // None of the injected prose survives into the query.
    expect(invocation?.query ?? "").not.toContain("system-reminder");
    expect(invocation?.query ?? "").not.toContain("CodeGraph");
    expect(invocation?.query ?? "").not.toContain("CLAUDE.md");
  });

  test("leaves user-typed markup alone", () => {
    // The reason this trims rather than strips: a blanket tag-strip would
    // destroy a legitimate question about markup or config.
    const request = {
      model: "m",
      source_surface: "messages",
      generation_controls: {},
      tools: [{ name: "web_search", native_type: "web_search_20250305" }],
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "how do I center a <div> with flexbox in <main>" }],
        },
      ],
    } as unknown as CanonicalRequest;
    expect(extractWebSearchInvocation(request)?.query).toBe(
      "how do I center a <div> with flexbox in <main>",
    );
  });

  test("bounds an oversized query", () => {
    const request = {
      model: "m",
      source_surface: "messages",
      generation_controls: {},
      tools: [{ name: "web_search", native_type: "web_search_20250305" }],
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "who is risuncode " + "noise ".repeat(400) }],
        },
      ],
    } as unknown as CanonicalRequest;
    const query = extractWebSearchInvocation(request)?.query ?? "";
    expect(query.length).toBeLessThanOrEqual(512);
    expect(query.startsWith("who is risuncode")).toBe(true);
  });

  test("passes a model-authored tool query through untouched", () => {
    const request = {
      model: "m",
      source_surface: "messages",
      generation_controls: {},
      tools: [{ name: "web_search", native_type: "web_search_20250305" }],
      messages: [
        { role: "user", content: [{ kind: "text", text: "anything" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "c1",
              name: "web_search",
              arguments: { query: "risuncode github profile" },
            },
          ],
        },
      ],
    } as unknown as CanonicalRequest;
    expect(extractWebSearchInvocation(request)?.query).toBe("risuncode github profile");
  });

  test("keeps a client-side WebSearch tool instead of consuming it", () => {
    // executes locally, with no hosted type marker. Treating it as hosted ran
    // the fallback bridge and stripped the declaration, so the upstream model
    // lost the tool and answered "I don't have a WebSearch tool".
    const clientSide = { name: "WebSearch", description: "Search the web" };
    const hosted = { name: "web_search", native_type: "web_search_20250305" };
    const wireHosted = { name: "anything", tool_type: "web_search" };

    expect(isWebSearchTool(clientSide as never)).toBe(false);
    expect(isWebSearchTool(hosted as never)).toBe(true);
    expect(isWebSearchTool(wireHosted as never)).toBe(true);

    // A model invoking that client-side tool by name is still asking for
    // search, so the invocation check stays name-based.
    expect(isWebSearchToolName("WebSearch")).toBe(true);
  });
});
