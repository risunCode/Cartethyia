export interface CapturedFetch {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

export type FakeFetchResponse = (call: CapturedFetch) => Response | Promise<Response>;

export async function withFakeFetch<T>(responseFactory: FakeFetchResponse, run: (calls: CapturedFetch[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const calls: CapturedFetch[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { input: String(input), init } satisfies CapturedFetch;
    calls.push(call);
    return responseFactory(call);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function sseBody(data: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of data) controller.enqueue(encoder.encode(`data: ${item}\n\n`));
      controller.close();
    },
  });
}

export async function collectReadableStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

export function decodeSseFrames(chunks: readonly Uint8Array[]): readonly string[] {
  const decoder = new TextDecoder();
  return decoder.decode(concatenate(chunks)).split("\n\n").filter((frame) => frame.length > 0);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
