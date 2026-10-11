/**
 * The buddy media path, against the shape cb actually answers.
 *
 * Image and video are the two generation surfaces the buddy family serves, and
 * both are easy to get subtly wrong, so these assertions are about the
 * *contract* rather than string output:
 *
 * - **image is a chat model.** cb answers `gemini-*-flash-image` on
 *   `/chat/completions`, and it rejects a body that does not open with a
 *   `system` turn (`11128`) or that is not streamed (`11101`). So the body this
 *   adapter posts must be the same buddy chat body the chat route sends —
 *   leading system, typed user content, `stream:true`. A raw `{prompt}` post is
 *   the bug this pins against.
 * - **cb refuses over HTTP 200.** Exhausted credits arrive as a 200 JSON
 *   envelope `{error:{data:{code,msg}}}`, not a 4xx. Surfacing `msg` verbatim is
 *   the difference between "top up" and a meaningless "no image".
 * - **video is an async task.** A submit returns `{data:{id,status:queued}}`;
 *   the clip is fetched from a sibling task endpoint, so the adapter has to poll
 *   until it stops being queued.
 *
 * The upstream is a mock: these run without credits, and they lock the request
 * shape and the poll loop, which is the part under our control.
 */
import { describe, expect, test } from "bun:test";
import {
  BuddyMediaAdapter,
  buddyErrorOf,
  extractChatImages,
} from "../../src/providers/integrations/buddy/buddy-media";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/contracts";

const IMAGE_TARGET = {
  provider_id: "cb",
  model_id: "gemini-3.1-flash-image",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const VIDEO_TARGET = {
  provider_id: "cb",
  model_id: "seedance-2.5",
  wire_family: "chat",
  endpoint_path: "/videos/generations",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    credential: { provider_id: "cb", credential_kind: "api_key", secret: new TextEncoder().encode("sk-cb") },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  } as unknown as ProviderDispatchContext;
}

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

function capture(responder: (call: Captured, index: number) => Response): { fetcher: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    const call: Captured = {
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** An SSE body of chat chunks whose concatenated content is `text`. */
function sseChunk(delta: string, finish = false): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: delta }, finish_reason: finish ? "stop" : null }],
  })}\n\n`;
}

function sseResponse(text: string): Response {
  const body = sseChunk(text) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function adapter(): BuddyMediaAdapter {
  // Constructed through the real factory path: chat config + media identity.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cfg = {
    provider_id: "cb" as const,
    base_url: "https://www.codebuddy.ai/v2",
    authentication_header_shape: "authorization_bearer" as const,
  };
  return new BuddyMediaAdapter(cfg as never, {
    variant: "IDE",
    systemPrompt: "SYSTEM",
    baseUrl: "https://www.codebuddy.ai/v2",
  });
}

describe("buddyGenerateImage — a chat-shaped body cb accepts", () => {
  test("posts a leading system turn, typed user content, and stream:true", async () => {
    const { fetcher, calls } = capture(() => sseResponse("![img](https://cdn.example/a.png)"));
    const result = await adapter().generateImage(
      { model: "gemini-3.1-flash-image", prompt: "a red apple" },
      IMAGE_TARGET,
      context(fetcher),
    );
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body!;
    // The three things cb enforces: a system turn first, stream on, model named.
    expect(body["stream"]).toBe(true);
    expect(body["model"]).toBe("gemini-3.1-flash-image");
    const messages = body["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("SYSTEM");
    // The user turn is typed content, not a bare string — buddy requires it.
    const user = messages[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    // And the endpoint is the chat completions path, not an images path.
    expect(calls[0]!.url).toBe("https://www.codebuddy.ai/v2/chat/completions");
    expect(result.data[0]).toEqual({ url: "https://cdn.example/a.png" });
  });

  test("surfaces cb's own refusal verbatim instead of a generic no-image", async () => {
    // cb returns exhausted-credits as HTTP 200 JSON, not 4xx and not SSE.
    const { fetcher } = capture(() =>
      new Response(
        JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted. Please top up." } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter().generateImage({ prompt: "a red apple" }, IMAGE_TARGET, context(fetcher)),
    ).rejects.toThrow(/Credits exhausted/);
  });

  test("a stream with no image is a failure, not an empty success", async () => {
    const { fetcher } = capture(() => sseResponse("I cannot make images."));
    await expect(
      adapter().generateImage({ prompt: "x" }, IMAGE_TARGET, context(fetcher)),
    ).rejects.toThrow(/no image/i);
  });
});

describe("buddyGenerateVideo — submit then poll to completion", () => {
  test("submits, polls the sibling task endpoint, and returns the clip URL", async () => {
    const { fetcher, calls } = capture((call, index) => {
      // First call: submit → queued task. Second call: status → finished clip.
      if (index === 0) {
        return new Response(
          JSON.stringify({ data: { id: "task-1", status: "queued" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(call.url).toBe("https://www.codebuddy.ai/v2/videos/generations/task-1");
      return new Response(
        JSON.stringify({ data: { id: "task-1", status: "succeeded", content: { video_url: "https://cdn.example/v.mp4" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await adapter().generateVideo(
      { model: "seedance-2.5", prompt: "a paper boat" },
      VIDEO_TARGET,
      context(fetcher),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ model: "seedance-2.5", prompt: "a paper boat" });
    expect(result).toEqual({ data: [{ url: "https://cdn.example/v.mp4" }], task_id: "task-1" });
  });

  test("a submit cb refuses over HTTP 200 surfaces its reason", async () => {
    const { fetcher } = capture(() =>
      new Response(
        JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted." } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter().generateVideo({ prompt: "x" }, VIDEO_TARGET, context(fetcher)),
    ).rejects.toThrow(/Credits exhausted/);
  });
});

describe("chat image extraction", () => {
  test("pulls a markdown image link", () => {
    expect(extractChatImages("here you go ![x](https://cdn.example/a.png) done")).toEqual([
      { url: "https://cdn.example/a.png" },
    ]);
  });

  test("pulls an inline base64 data URI with its mime type", () => {
    const row = extractChatImages("data:image/png;base64,QUJD")[0]!;
    expect(row).toEqual({ b64_json: "QUJD", mime_type: "image/png" });
  });

  test("text with no image yields nothing", () => {
    expect(extractChatImages("just words")).toEqual([]);
  });
});

describe("buddyErrorOf", () => {
  test("reads the nested cb envelope", () => {
    expect(buddyErrorOf({ error: { data: { code: 14018, msg: "Credits exhausted." } } })).toBe("Credits exhausted.");
  });

  test("falls back to the code when no message", () => {
    expect(buddyErrorOf({ error: { data: { code: 11128 } } })).toBe("CodeBuddy error 11128");
  });

  test("a body with no error yields undefined", () => {
    expect(buddyErrorOf({ data: { id: "x" } })).toBeUndefined();
  });
});
