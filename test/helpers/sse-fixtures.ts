/**
 * SSE/stream test fixtures shared by the protocol decoders.
 *
 * `streamOf` and `collect` were copy-pasted into four protocol test files with
 * identical bodies. The chunk-array variants in `stream-framing-golden.test.ts`
 * and `transport/streaming.test.ts` are deliberately NOT replaced: they take
 * arrays of chunks and exercise framing boundaries, which is a different
 * fixture with a different purpose.
 */
import type { CanonicalEvent } from "../../src/transport/canonical-model";

const encoder = new TextEncoder();

/** One SSE/text body as a single-chunk readable stream. */
export function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Drains an async iterable into an array. */
export async function collect(iterable: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/**
 * A JSON `Response` for a stubbed upstream call.
 *
 * Fourteen test files declared this with four slightly different signatures
 * (`body` vs `value`, with and without a `status` parameter). The superset is
 * behaviourally identical to all of them: every call site passes a JSON body,
 * and only the ones that need a non-200 status pass the second argument.
 */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
