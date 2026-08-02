import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { codexProvider } from "../../../src/upstream/providers/codex";

function target() {
  const value = codexProvider.resolveTarget("gpt-5.4-mini");
  if (!value) throw new Error("Codex test model did not resolve");
  return value;
}

describe("Codex provider", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("translates system messages to developer messages for Responses", async () => {
    await codexProvider.call(target(), {
      surface: "openai-chat",
      body: {
        model: "gpt-5.4-mini",
        stream: false,
        messages: [
          { role: "system", content: "Answer briefly." },
          { role: "user", content: "Hello." },
        ],
      },
    }, {
      kind: "oauth",
      value: "access-token",
      providerMetadata: { chatgptAccountId: "chatgpt-account-1" },
    }, AbortSignal.timeout(1_000));

    const request = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { input: Array<{ role?: string }>; store?: boolean; stream?: boolean };
    expect(body.input.map((item) => item.role)).toEqual(["developer", "user"]);
    expect(request?.headers).toMatchObject({ "chatgpt-account-id": "chatgpt-account-1" });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test("does not use the internal account id as the ChatGPT identity", async () => {
    await expect(codexProvider.call(target(), {
      surface: "openai-chat",
      body: { model: "gpt-5.4-mini", messages: [{ role: "user", content: "Hello." }] },
    }, {
      kind: "oauth",
      value: "access-token",
      accountId: "internal-db-account-id",
    }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      status: 401,
      message: "Codex OAuth credential is missing its ChatGPT account identity.",
    });
  });
});
