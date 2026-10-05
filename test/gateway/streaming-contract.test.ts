/**
 * The streaming dispatch contract: what a client receives, and what the
 * gateway releases, for every way a provider stream can end.
 *
 * `handleProviderProxyRequest`'s streaming branch is the hottest and most
 * consequential path in the gateway — it owns the admission lease, the routing
 * reservation, and the network-pool slot for the whole body lifetime, and it
 * decides what a client sees when the upstream fails. It was also, measured
 * before this file existed, covered only on its happy path: the repository had
 * tests for a stream that completes and none for truncation, an upstream
 * failure terminal, a silent provider, or a client that leaves mid-stream.
 *
 * That gap is what makes the branch unsafe to restructure, so these tests pin
 * the observable contract first — the encoded frames a client reads, and the
 * in-flight gauge returning to zero — and say nothing about how the branch is
 * organised internally. A refactor that preserves this file's assertions
 * preserves the behavior callers depend on.
 *
 * Two properties are load-bearing and each is a way a real stream goes wrong:
 *
 * 1. **A stream that ends without a terminal event is a failure, not a clean
 *    close.** A TCP cut must not reach the client as `finish_reason: "stop"`,
 *    or the client believes a truncated answer was complete.
 * 2. **Every outcome releases.** The lease, reservation, and pool slot are
 *    held by the stream's async lifetime, so a path that returns without
 *    releasing leaks capacity for the life of the process. The gauge is the
 *    detector: `inFlightCount()` is decremented only by `state.cleanup()`,
 *    which only `releaseStreamResources` reaches.
 *
 * The stub adapter is driven through its real `dispatch()` seam, so the router,
 * admission, routing, and the streaming branch all run for real; only the
 * upstream bytes are synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import type { CanonicalEvent } from "../../src/transport/canonical-model";

const USAGE = {
  input_tokens: 12,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  uncached_input_tokens: 12,
  output_tokens: 4,
  reasoning_tokens: 0,
  estimated_cost: 0,
} as const;

const START: CanonicalEvent = {
  type: "message_start",
  sequence_number: 0,
  event_id: "msg_test",
  model: "test-model",
};

const DELTA: CanonicalEvent = {
  type: "content_delta",
  sequence_number: 1,
  content: { kind: "text", text: "Hello from Cartethyia" },
};

const COMPLETE: CanonicalEvent = {
  type: "terminal",
  sequence_number: 2,
  state: "complete",
  stop_reason: "stop",
  usage: USAGE,
};

const FAILED: CanonicalEvent = {
  type: "terminal",
  sequence_number: 2,
  state: "failed",
  stop_reason: "error",
  provider_stop_reason: "upstream_broke",
  usage: USAGE,
};

/** Splits an SSE body into its `data:` payloads, in order. */
function sseFrames(body: string): string[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length));
}

/** The first frame carrying a top-level `error` envelope, parsed. */
function errorEnvelope(
  frames: readonly string[],
): { origin: string; code: string; message: string } | undefined {
  for (const frame of frames) {
    if (frame === "[DONE]") continue;
    try {
      const parsed = JSON.parse(frame) as {
        error?: { origin: string; code: string; message: string };
      };
      // A substring match is not enough: a chunk's `"finish_reason":"error"`
      // also contains `"error"`, so the envelope is identified by its
      // top-level key rather than by text.
      if (parsed.error !== undefined) return parsed.error;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The `finish_reason` of the last chunk that carries one, or undefined. */
function lastFinishReason(frames: readonly string[]): string | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const raw = frames[i];
    if (raw === undefined || raw === "[DONE]") continue;
    try {
      const parsed = JSON.parse(raw) as {
        choices?: { finish_reason?: string | null }[];
      };
      const reason = parsed.choices?.[0]?.finish_reason;
      if (reason != null) return reason;
    } catch {
      continue;
    }
  }
  return undefined;
}

dbDescribe("streaming dispatch contract", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    gateway.serveWorld(world);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  /** Issues a streaming Chat request and returns the decoded SSE frames. */
  async function streamChat(): Promise<{ status: number; frames: string[]; body: string }> {
    const response = await gateway.json(
      "/v1/chat/completions",
      {
        model: world.qualifiedModel,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      { token: world.token },
    );
    const body = await response.text();
    return { status: response.status, frames: sseFrames(body), body };
  }

  describe("a stream that completes", () => {
    test("ends with [DONE] after a stop finish reason", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      const { status, frames } = await streamChat();
      expect(status).toBe(200);
      // `[DONE]` is what tells an OpenAI client the stream ended cleanly; a
      // stream that stops without it makes the client retry or hang.
      expect(frames[frames.length - 1]).toBe("[DONE]");
      expect(lastFinishReason(frames)).toBe("stop");
    });

    test("carries the upstream usage on the final chunk", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      const { frames } = await streamChat();
      const withUsage = frames.find((frame) => frame.includes('"usage":{'));
      expect(withUsage).toBeDefined();
      const parsed = JSON.parse(withUsage as string) as {
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      expect(parsed.usage.prompt_tokens).toBe(USAGE.input_tokens);
      expect(parsed.usage.completion_tokens).toBe(USAGE.output_tokens);
      expect(parsed.usage.total_tokens).toBe(USAGE.input_tokens + USAGE.output_tokens);
    });

    test("delivers the provider's content to the client", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      const { body } = await streamChat();
      expect(body).toContain("Hello from Cartethyia");
    });
  });

  describe("a stream that ends without a terminal event", () => {
    test("is reported as an error finish reason, never as a clean stop", async () => {
      // The provider closed the socket after content. Reporting `stop` here
      // would tell the client a truncated answer was complete.
      gateway.adapter(world.providerId, { events: () => [START, DELTA] });
      const { status, frames } = await streamChat();
      // The status is already committed to 200 by the time the body streams —
      // that is inherent to SSE — so the failure has to ride in the frames.
      expect(status).toBe(200);
      expect(lastFinishReason(frames)).toBe("error");
    });

    test("a provider that produces nothing at all still answers the client", async () => {
      // An empty event list means the adapter yielded no frames. The client
      // must still get a well-formed, terminated stream rather than a socket
      // that opens and closes with nothing on it.
      gateway.adapter(world.providerId, { events: () => [] });
      const { status, frames } = await streamChat();
      expect(status).toBe(200);
      expect(frames[frames.length - 1]).toBe("[DONE]");
      expect(lastFinishReason(frames)).toBe("error");
    });
  });

  describe("a stream whose terminal event reports failure", () => {
    test("emits an error envelope after the partial content", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, FAILED] });
      const { frames } = await streamChat();
      const error = errorEnvelope(frames);
      expect(error).toBeDefined();
      // A terminal `failed` state is only ever written by the upstream
      // decoders, so the failure is the upstream's, not the gateway's.
      expect(error?.origin).toBe("upstream");
      expect(error?.code).toBe("transport_unavailable");
    });

    test("still reports an error finish reason to a client reading only choices", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, FAILED] });
      const { frames } = await streamChat();
      expect(lastFinishReason(frames)).toBe("error");
    });
  });

  describe("resource release", () => {
    /** Waits for the gauge to settle; release is not synchronous with the body. */
    async function settle(): Promise<number> {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (gateway.stateStore.inFlightCount() === 0) return 0;
        await Bun.sleep(25);
      }
      return gateway.stateStore.inFlightCount();
    }

    test("a completed stream returns the in-flight gauge to zero", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      await streamChat();
      expect(await settle()).toBe(0);
    });

    test("a truncated stream returns the in-flight gauge to zero", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA] });
      await streamChat();
      expect(await settle()).toBe(0);
    });

    test("a failed-terminal stream returns the in-flight gauge to zero", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, FAILED] });
      await streamChat();
      expect(await settle()).toBe(0);
    });

    test("an empty stream returns the in-flight gauge to zero", async () => {
      gateway.adapter(world.providerId, { events: () => [] });
      await streamChat();
      expect(await settle()).toBe(0);
    });

    test("a client that abandons the stream mid-body releases anyway", async () => {
      // The case the release guards exist for. A client that stops reading
      // leaves no pending `pull()`, so the abort listener — not the pull's own
      // error handler — has to release. Without it the flight stayed on the
      // gauge for the life of the process.
      gateway.adapter(world.providerId, {
        events: () => [
          START,
          ...Array.from({ length: 40 }, (_, index) => ({
            ...DELTA,
            sequence_number: index + 1,
          })),
          COMPLETE,
        ],
      });
      const controller = new AbortController();
      const response = await gateway.json(
        "/v1/chat/completions",
        {
          model: world.qualifiedModel,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        { token: world.token, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      expect(await settle()).toBe(0);
    });

    test("sequential streams do not accumulate flights", async () => {
      // A leak that releases only on the *last* stream would still pass every
      // single-stream test above; three in a row catches an off-by-one in the
      // single-shot guards.
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      for (let index = 0; index < 3; index += 1) {
        await streamChat();
        expect(await settle()).toBe(0);
      }
    });
  });

  describe("the non-streaming path answers the same upstream conditions", () => {
    async function jsonChat(): Promise<{ status: number; body: unknown }> {
      const response = await gateway.json(
        "/v1/chat/completions",
        {
          model: world.qualifiedModel,
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
        { token: world.token },
      );
      return { status: response.status, body: (await response.json()) as unknown };
    }

    test("a missing terminal event is a 502, not an empty success", async () => {
      // The streaming path can only report this inside the body (the status is
      // already sent); the non-streaming path still owns a real status code, so
      // the same upstream condition must not read as a success here.
      gateway.adapter(world.providerId, { events: () => [START, DELTA] });
      const { status, body } = await jsonChat();
      expect(status).toBe(502);
      expect(JSON.stringify(body)).toContain("transport_unavailable");
    });

    test("a failed terminal event is a 502", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, FAILED] });
      const { status } = await jsonChat();
      expect(status).toBe(502);
    });

    test("a complete stream still returns 200 with usage", async () => {
      gateway.adapter(world.providerId, { events: () => [START, DELTA, COMPLETE] });
      const { status, body } = await jsonChat();
      expect(status).toBe(200);
      const envelope = body as { usage?: { total_tokens?: number } };
      expect(envelope.usage?.total_tokens).toBe(USAGE.input_tokens + USAGE.output_tokens);
    });
  });
});
