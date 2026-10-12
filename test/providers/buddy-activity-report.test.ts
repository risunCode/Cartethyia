import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_REPORT_EVENTS_PER_BATCH,
  ACTIVITY_REPORT_ROUNDS,
  fetchBuddyActivityReport,
} from "../../src/providers/integrations/buddy/buddy-checkin";

/**
 * The growth report is what the billing facade scores as chat activity. One
 * event did not move the growth tasks; the report has to go out as four
 * events per batch, twice, with a pause between the rounds — and that shape
 * has to hold for every buddy variant, not just one of them.
 */

interface CapturedCall {
  readonly url: string;
  readonly body: unknown;
}

function capturingFetcher(calls: CapturedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchBuddyActivityReport — staged batches for every buddy variant", () => {
  for (const providerId of ["cb", "cbcn", "workbuddy", "workbuddycn"]) {
    test(`${providerId}: two rounds of four distinct events, paused between them`, async () => {
      const calls: CapturedCall[] = [];
      const pauses: number[] = [];
      const result = await fetchBuddyActivityReport({
        providerId,
        accountId: "acct-1",
        credential: "credential",
        userId: "uid-1",
        fetcher: capturingFetcher(calls),
        conversationId: "conv",
        sleep: async (ms) => {
          pauses.push(ms);
        },
      });

      expect(result.state).toBe("reported");
      expect(calls).toHaveLength(ACTIVITY_REPORT_ROUNDS);
      expect(pauses).toEqual([1_500]);

      const ids = new Set<string>();
      for (const call of calls) {
        expect(Array.isArray(call.body)).toBe(true);
        const events = call.body as Array<{ conversationId: string; requestId: string }>;
        expect(events).toHaveLength(ACTIVITY_REPORT_EVENTS_PER_BATCH);
        for (const event of events) ids.add(`${event.conversationId}|${event.requestId}`);
      }
      // Eight events, eight ids. A repeated id is dropped by the facade as a
      // duplicate, so a batch of identical events would score as one.
      expect(ids.size).toBe(ACTIVITY_REPORT_ROUNDS * ACTIVITY_REPORT_EVENTS_PER_BATCH);
    });
  }

  test("a failed first round stops the sequence", async () => {
    const calls: CapturedCall[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      calls.push({ url: String(url), body: null });
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await fetchBuddyActivityReport({
      providerId: "cbcn",
      accountId: "acct-1",
      credential: "credential",
      userId: "uid-1",
      fetcher,
      sleep: async () => {
        throw new Error("second round must not be attempted");
      },
    });

    expect(result.state).toBe("error");
    expect(calls).toHaveLength(1);
  });
});
