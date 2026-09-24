import { describe, expect, test } from "bun:test";
import {
  attemptDailyGrowthPass,
  checkinDayKey,
  ledgerKey,
  supportsDailyCheckin,
} from "../../src/workers/daily-checkin";
import {
  buildActivityReportEvent,
  fetchBuddyActivityReport,
  fetchDailyCheckin,
} from "../../src/providers/integrations/buddy/buddy-checkin";
import type { RedisClient } from "../../src/persistence/redis";

/** Minimal in-memory RedisClient fake covering `SET NX EX` and `DEL`. */
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  return {
    async set(key: string, _value: string, ...args: (string | number)[]): Promise<string | null> {
      let nx = false;
      for (const arg of args) {
        if (String(arg).toUpperCase() === "NX") nx = true;
      }
      if (nx && store.has(key)) return null;
      store.set(key, _value);
      return "OK";
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
  } as unknown as RedisClient;
}

/** Records the URLs and headers a fake fetch was called with. */
function recordingFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const payload = responses[url];
    return new Response(JSON.stringify(payload ?? { code: 0, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls, headers };
}

// Base URLs differ per provider: `workbuddy` is bare so the module prepends
// `/v2`, while `cb`/`cbcn` already end in `/v2`.
const WB = "https://www.workbuddy.ai/v2/billing/meter";
const CB = "https://www.codebuddy.ai/v2/billing/meter";
const CBCN = "https://copilot.tencent.com/v2/billing/meter";

describe("supportsDailyCheckin", () => {
  test("covers the WorkBuddy/CodeBuddy billing providers only", () => {
    expect(supportsDailyCheckin("workbuddy")).toBe(true);
    expect(supportsDailyCheckin("cb")).toBe(true);
    expect(supportsDailyCheckin("cbcn")).toBe(true);
    expect(supportsDailyCheckin("openai")).toBe(false);
  });
});

describe("attemptDailyGrowthPass", () => {
  test("claims once per day and skips subsequent passes", async () => {
    const redis = fakeRedis();
    const { fetcher } = recordingFetch({
      [`${WB}/checkin-activity-status`]: { code: 0, data: { active: true, today_checked_in: false } },
      [`${WB}/daily-checkin`]: { code: 0, data: { credit: 50 } },
    });
    const deps = {
      redis,
      providerId: "workbuddy" as const,
      accountId: "acc-1",
      resolveCredential: async () => "token",
      fetcher,
    };

    const first = await attemptDailyGrowthPass(deps);
    expect(first?.checkin.state).toBe("claimed");

    // Same day: no second claim at all.
    const second = await attemptDailyGrowthPass(deps);
    expect(second).toBeNull();
  });

  test("releases the day slot when the attempt errors so a later pass retries", async () => {
    const redis = fakeRedis();
    const fetcher = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const deps = {
      redis,
      providerId: "workbuddy" as const,
      accountId: "acc-2",
      resolveCredential: async () => "stale",
      fetcher,
    };

    const failed = await attemptDailyGrowthPass(deps);
    expect(failed?.checkin.state).toBe("error");

    // Slot released, so the retry is not short-circuited.
    const retry = await attemptDailyGrowthPass(deps);
    expect(retry?.checkin.state).toBe("error");
  });

  test("clearing the day marker lets the same day retry", async () => {
    const redis = fakeRedis();
    const { fetcher } = recordingFetch({
      [`${WB}/checkin-activity-status`]: { code: 0, data: { active: true, today_checked_in: false } },
      [`${WB}/daily-checkin`]: { code: 0, data: { credit: 50 } },
    });
    const deps = {
      redis,
      providerId: "workbuddy" as const,
      accountId: "acc-3",
      resolveCredential: async () => "token",
      fetcher,
    };

    await attemptDailyGrowthPass(deps);
    expect(await attemptDailyGrowthPass(deps)).toBeNull();

    // The exported key is the one the sweep writes; clearing it re-opens the day.
    await redis.del(ledgerKey(checkinDayKey(), "acc-3"));
    expect((await attemptDailyGrowthPass(deps))?.checkin.state).toBe("claimed");
  });

  test("isolates a credential resolution failure", async () => {
    const redis = fakeRedis();
    const result = await attemptDailyGrowthPass({
      redis,
      providerId: "workbuddy" as const,
      accountId: "acc-4",
      resolveCredential: async () => {
        throw new Error("no credential");
      },
      fetcher: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(result?.checkin.state).toBe("error");
    expect(result?.checkin.error).toContain("no credential");
  });
});

describe("fetchDailyCheckin", () => {
  test("claims once and returns the granted credit", async () => {
    const { fetcher, calls } = recordingFetch({
      [`${WB}/checkin-activity-status`]: {
        code: 0,
        data: { active: true, today_checked_in: false, streak_days: 3 },
      },
      [`${WB}/daily-checkin`]: { code: 0, data: { credit: 100, streak_days: 4 } },
    });

    const result = await fetchDailyCheckin({
      providerId: "workbuddy",
      accountId: "acc-1",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("claimed");
    expect(result.credit).toBe(100);
    expect(result.streakDays).toBe(4);
    expect(calls).toEqual([`${WB}/checkin-activity-status`, `${WB}/daily-checkin`]);
  });

  test("does not POST the claim when today is already claimed", async () => {
    const { fetcher, calls } = recordingFetch({
      [`${WB}/checkin-activity-status`]: {
        code: 0,
        data: { active: true, today_checked_in: true, streak_days: 7 },
      },
    });

    const result = await fetchDailyCheckin({
      providerId: "workbuddy",
      accountId: "acc-1",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("already_claimed");
    expect(calls).toEqual([`${WB}/checkin-activity-status`]);
  });

  test("treats business code 1001 on the claim as already claimed", async () => {
    const { fetcher } = recordingFetch({
      [`${WB}/checkin-activity-status`]: { code: 0, data: { active: true } },
      [`${WB}/daily-checkin`]: { code: 1001 },
    });

    const result = await fetchDailyCheckin({
      providerId: "workbuddy",
      accountId: "acc-1",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("already_claimed");
  });

  test("sends CodeBuddy intl to the .ai host with the IDE identity", async () => {
    const { fetcher, calls, headers } = recordingFetch({
      [`${CB}/checkin-activity-status`]: { code: 0, data: { active: true, today_checked_in: false } },
      [`${CB}/daily-checkin`]: { code: 0, data: { credit: 25 } },
    });

    const result = await fetchDailyCheckin({
      providerId: "cb",
      accountId: "acc-intl",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("claimed");
    expect(calls).toEqual([`${CB}/checkin-activity-status`, `${CB}/daily-checkin`]);
    expect(headers[0]?.["X-Domain"]).toBe("www.codebuddy.ai");
    expect(headers[0]?.["X-IDE-Type"]).toBe("IDE");
  });

  test("sends CodeBuddy CN to the Tencent host with the CLI identity", async () => {
    const { fetcher, calls, headers } = recordingFetch({
      [`${CBCN}/checkin-activity-status`]: {
        code: 0,
        data: { active: true, today_checked_in: false },
      },
      [`${CBCN}/daily-checkin`]: { code: 0, data: { credit: 30 } },
    });

    const result = await fetchDailyCheckin({
      providerId: "cbcn",
      accountId: "acc-cn",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("claimed");
    expect(calls).toEqual([`${CBCN}/checkin-activity-status`, `${CBCN}/daily-checkin`]);
    expect(headers[0]?.["X-Domain"]).toBe("copilot.tencent.com");
    expect(headers[0]?.["X-IDE-Type"]).toBe("CLI");
  });

  test("reads the Tencent double-wrapped check-in envelope", async () => {
    const { fetcher } = recordingFetch({
      [`${CBCN}/checkin-activity-status`]: {
        code: 0,
        data: { Response: { Data: { active: true, today_checked_in: false } } },
      },
      [`${CBCN}/daily-checkin`]: {
        code: 0,
        data: { Response: { Data: { credit: 30, streak_days: 9 } } },
      },
    });

    const result = await fetchDailyCheckin({
      providerId: "cbcn",
      accountId: "acc-cn",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("claimed");
    expect(result.credit).toBe(30);
    expect(result.streakDays).toBe(9);
  });
});

describe("checkinDayKey", () => {
  test("is a UTC calendar day", () => {
    expect(checkinDayKey(new Date("2026-09-20T23:59:59Z"))).toBe("2026-09-20");
  });
});

describe("fetchDailyCheckin resilience", () => {
  test("retries the claim once on a transient 500, then succeeds", async () => {
    let claims = 0;
    const fetcher = (async (url: string) => {
      if (url.endsWith("/checkin-activity-status")) {
        return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }), {
          status: 200,
        });
      }
      claims += 1;
      if (claims === 1) return new Response("upstream exploded", { status: 500 });
      return new Response(JSON.stringify({ code: 0, data: { credit: 10, streak_days: 3 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await fetchDailyCheckin({
      providerId: "workbuddy",
      accountId: "acc-retry",
      credential: "token",
      fetcher,
    });

    expect(claims).toBe(2);
    expect(result.state).toBe("claimed");
    expect(result.credit).toBe(10);
  });

  test("treats a prose already-checked-in answer as already_claimed", async () => {
    const fetcher = (async (url: string) => {
      if (url.endsWith("/checkin-activity-status")) {
        return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 1001, msg: "already checked in today" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await fetchDailyCheckin({
      providerId: "cb",
      accountId: "acc-prose",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("already_claimed");
  });

  test("treats a CJK already-checked-in answer as already_claimed", async () => {
    const fetcher = (async (url: string) => {
      if (url.endsWith("/checkin-activity-status")) {
        return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 0, msg: "今日已签到，明日再来" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchDailyCheckin({
      providerId: "cbcn",
      accountId: "acc-cjk",
      credential: "token",
      fetcher,
    });

    expect(result.state).toBe("already_claimed");
  });
});

describe("fetchBuddyActivityReport", () => {
  const WB = "https://www.workbuddy.ai/v2/report";

  test("builds a full-shape chat_request_send event with the account uid", () => {
    const event = buildActivityReportEvent({ conversationId: "activity-1", userId: "uid-9", now: 1758508800000 });
    expect(event.eventCode).toBe("chat_request_send");
    expect(event.userId).toBe("uid-9");
    expect(event.conversationId).toBe("activity-1");
    expect(event.requestId).toBe("activity-1");
    expect(event.timestamp).toBe(1758508800000);
    expect(event.agentName).toBe("default");
  });

  test("posts the event array and stamps the uid header", async () => {
    const calls: string[] = [];
    const headers: Record<string, string>[] = [];
    let body = "";
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchBuddyActivityReport({
      providerId: "workbuddy",
      accountId: "acc-1",
      credential: "token",
      userId: "uid-9",
      fetcher,
      conversationId: "activity-1",
    });

    expect(result.state).toBe("reported");
    expect(calls).toEqual([WB]);
    expect(headers[0]?.["X-User-Id"]).toBe("uid-9");
    expect(headers[0]?.["Authorization"]).toBe("Bearer token");
    const events = JSON.parse(body) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.["eventCode"]).toBe("chat_request_send");
    expect(events[0]?.["userId"]).toBe("uid-9");
  });

  test("fails closed without a uid", async () => {
    const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchBuddyActivityReport({
      providerId: "cb",
      accountId: "acc-2",
      credential: "token",
      userId: "",
      fetcher,
    });
    expect(result.state).toBe("error");
  });

  test("maps a non-zero envelope code to error", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ code: 5001, msg: "nope" }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchBuddyActivityReport({
      providerId: "cbcn",
      accountId: "acc-3",
      credential: "token",
      userId: "uid-3",
      fetcher,
    });
    expect(result.state).toBe("error");
  });
});

describe("check-in provider eligibility", () => {
  test("covers the buddy family and excludes everything else", () => {
    // The route only exists on the buddy gateways; claiming another provider
    // eligible would spend a day slot on a wire that does not exist.
    expect(supportsDailyCheckin("workbuddy")).toBe(true);
    expect(supportsDailyCheckin("cb")).toBe(true);
    expect(supportsDailyCheckin("cbcn")).toBe(true);
    expect(supportsDailyCheckin("openai")).toBe(false);
  });
});
