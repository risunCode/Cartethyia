import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";

import { app } from "../../src/app";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/chat/completions with Qoder namespace", () => {
  test("rejects a Qoder request without a personal access token", async () => {
    const res = await postChat({ model: "qoder/qmodel_latest", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("exchanges a Qoder PAT and forwards a signed encoded request", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "qoder-user", securityOauthToken: "qoder-oauth-token", refreshToken: "refresh-token" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "hello from qoder" }, finish_reason: null }] }) })}\n\n` +
            `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) })}\n\n` +
            `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );

    const res = await postChat(
      { model: "qoder/qmodel_latest", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer qoder-personal-access-token" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from qoder");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [chatUrl, chatInit] = fetchSpy.mock.calls[1]!;
    expect(String(chatUrl)).toContain("api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation");
    const headers = (chatInit as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toStartWith("Bearer COSY.");
    expect(headers["x-model-key"]).toBe("qmodel_latest");
    expect(headers["user-agent"]).toBe("Go-http-client/2.0");
    expect(String((chatInit as RequestInit).body)).not.toContain("qoder-personal-access-token");
  });
});
