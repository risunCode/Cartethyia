import { describe, expect, test } from "bun:test";
import { buddyPrePayloadCommon } from "../../src/providers/integrations/buddy/buddy-chat-shared";
import { readBuddyDeviceToken, workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy-shared";
import { fetchTencentBillingQuota } from "../../src/providers/integrations/buddy/buddy-quota-shared";
import { parseDsmlToolCalls } from "../../src/protocol/response/dsml";
import { parseChatResponseToEvents } from "../../src/protocol/response/chat";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext } from "../../src/providers/contracts";

const request = { model: "glm-5.2", messages: [] } as unknown as CanonicalRequest;
const context = {
  credential: { account_id: "abcdef123456", auth_state: { deviceToken: "desktop-token" } },
} as unknown as ProviderDispatchContext;

describe("Buddy upstream protocol alignment", () => {
  test("keeps tools when tool_choice is none and injects an account-scoped cache key", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "run_shell" } }],
      tool_choice: "none",
    };
    buddyPrePayloadCommon(payload, request, context);
    expect(payload["tool_choice"]).toBe("none");
    expect(payload["tools"]).toHaveLength(1);
    expect(payload["prompt_cache_key"]).toBeString();
    expect(String(payload["prompt_cache_key"])).toStartWith("wb2a-abcdef12-");
  });

  test("clamps an unsupported international effort without touching a supported one", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
      prompt_cache_key: "client-key",
    };
    buddyPrePayloadCommon(payload, request, context, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["prompt_cache_key"]).toBe("client-key");
  });

  test("uses the CN effort ladder for the same model", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
    };
    buddyPrePayloadCommon(payload, request, context, "cn");
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("sends the desktop device token only when the account has one", async () => {
    const headers = await workbuddyHeaders(context, request);
    expect(headers["x-device-token"]).toBe("desktop-token");
    expect(readBuddyDeviceToken({ credential: { auth_state: {} } } as unknown as ProviderDispatchContext)).toBeUndefined();
  });

  test("recovers a complete DSML block as a tool call", () => {
    const pipe = "\uFF5C\uFF5C";
    const text = `<${pipe}DSML${pipe} calls><${pipe}DSML${pipe} invoke name="run_shell"><${pipe}DSML${pipe} parameter name="command" string="true">ls</${pipe}DSML${pipe} parameter></${pipe}DSML${pipe} invoke></${pipe}DSML${pipe} calls>`;
    const recovered = parseDsmlToolCalls(text);
    expect(recovered?.calls[0]?.name).toBe("run_shell");
    expect(JSON.parse(recovered?.calls[0]?.arguments ?? "{}")).toEqual({ command: "ls" });
    const events = parseChatResponseToEvents({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }, request);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "run_shell")).toBe(true);
  });

  test("reads enterprise usage when the personal package list is empty", async () => {
    const fetcher = (async (url: string) => new Response(JSON.stringify(
      String(url).endsWith("/get-user-resource")
        ? { code: 0, data: { Response: { Data: { Accounts: [] } } } }
        : { code: 0, data: { credit: 200, limitNum: 1000, cycleEndTime: "2026-10-26 23:59:59" } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "workbuddy",
      display: "WorkBuddy",
      url: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
      headers: { "X-Enterprise-Id": "ent-1" },
      credential: "token",
      fetcher,
      defaultPlan: "WorkBuddy",
    });
    expect(result.plan).toBe("Enterprise");
    expect(result.windows[0]?.remaining).toBe(800);
    expect(result.windows[0]?.limit).toBe(1000);
  });

  test("classifies refill and bonus packages into the same spendable credit pool", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: "Monthly",
                CycleCapacityUsedPrecise: "0",
                CycleCapacitySizePrecise: "100",
                CycleEndTime: "2030-11-01 00:00:00",
                DeductionEndTime: "2030-12-01 00:00:00",
              },
              {
                PackageName: "Bonus",
                CapacityUsedPrecise: "30",
                CapacitySizePrecise: "30",
                CycleEndTime: "2030-11-15 00:00:00",
              },
            ],
          },
        },
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "cb",
      display: "CodeBuddy",
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
      headers: {},
      credential: "token",
      fetcher,
      defaultPlan: "CodeBuddy",
    });

    expect(result.windows.map((entry) => entry.accounting)).toEqual(["pooled", "pooled"]);
  });
});
