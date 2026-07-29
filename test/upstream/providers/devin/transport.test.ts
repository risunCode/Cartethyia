import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { GetChatMessageRequestSchema, GetChatMessageResponseSchema } from "../../../../src/upstream/providers/devin/generated/exa/api_server_pb/api_server_pb";
import { buildDevinChatRequest, decodeDevinChatStream } from "../../../../src/upstream/providers/devin/transport";

describe("buildDevinChatRequest", () => {
  test("frames a gzip-compressed Connect request", () => {
    const request = buildDevinChatRequest(
      "session-token",
      "user-jwt",
      "swe-1-6-slow",
      { messages: [{ role: "user", content: "hello" }] },
    );

    expect(request.headers).toMatchObject({
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-content-encoding": "gzip",
      "connect-accept-encoding": "gzip",
      "accept-encoding": "identity",
    });
    expect(request.body[0]).toBe(0x01);

    const frameLength = new DataView(request.body.buffer, request.body.byteOffset, request.body.byteLength).getUint32(1);
    expect(frameLength).toBe(request.body.length - 5);

    const decoded = fromBinary(GetChatMessageRequestSchema, gunzipSync(request.body.subarray(5)));
    expect(decoded.metadata?.apiKey).toBe("devin-session-token$session-token");
    expect(decoded.metadata?.userJwt).toBe("user-jwt");
    expect(decoded.chatModelUid).toBe("swe-1-6-slow");
  });

  test("emits visible response text from a Connect frame", async () => {
    const payload = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, { deltaText: "Devin connection is working." }));
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(frame); controller.close(); } });

    const events = [];
    for await (const event of decodeDevinChatStream(body)) events.push(event);

    expect(events).toContainEqual({ type: "text_delta", text: "Devin connection is working." });
  });
});
