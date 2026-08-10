import { describe, expect, test } from "bun:test";
import { callQoder, QODER_CHAT_URL, QODER_MODE_PROFILE, type QoderAuth } from "../src/providers/qoder";

const AUTH: QoderAuth = {
  userId: "qoder-user",
  userName: "Qoder User",
  userType: "personal_standard",
  securityOauthToken: "oauth-token",
  refreshToken: "refresh-token",
  machineId: "machine-id",
};

describe("Qoder modern wire profile", () => {
  test("uses the current API2 COSY profile", () => {
    expect(QODER_MODE_PROFILE).toEqual({
      cosyVersion: "1.0.22",
      chatUrl: QODER_CHAT_URL,
      businessProduct: "cli",
      businessType: "agent",
      businessVersion: "1.0.22",
      cosyScene: "assistant",
      mirrorTopLevelSystem: true,
      sendBusinessHeaders: true,
      sendModelSourceHeaders: true,
      emptyAliyunUserType: true,
    });
    expect(QODER_CHAT_URL).toStartWith("https://api2.qoder.sh/");
  });

  test("sends modern business and model-source headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const response = await callQoder(
      QODER_CHAT_URL,
      { model_config: { source: "system" } },
      "auto",
      AUTH,
      new AbortController().signal,
      async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response("", { status: 200 });
      },
    );

    const headers = new Headers(capturedInit?.headers);
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe(QODER_CHAT_URL);
    expect(headers.get("cosy-version")).toBe("1.0.22");
    expect(headers.get("cosy-business-product")).toBe("cli");
    expect(headers.get("cosy-business-type")).toBe("agent");
    expect(headers.get("cosy-business-version")).toBe("1.0.22");
    expect(headers.get("cosy-scene")).toBe("assistant");
    expect(headers.get("x-model-key")).toBe("auto");
    expect(headers.get("x-model-source")).toBe("system");
  });
});
