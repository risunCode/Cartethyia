import { afterEach, describe, expect, test } from "bun:test";
import { getRequestDetailBundle, insertRequestDetails, purgeAllStoredData, deleteRequestDetailsOlderThan } from "../../src/console/db/repos/details";

afterEach(() => { purgeAllStoredData(); });

describe("request detail retention", () => {
  test("request_details is durable across a large insert volume - no in-memory cap", () => {
    // Previously request_details was an in-process Map capped at 5,000
    // entries (evicting the oldest once memory pressure mattered). Now it's a
    // SQLite table in runtime.sqlite bounded only by date-cutoff retention
    // (see deleteRequestDetailsOlderThan), so every inserted row survives.
    for (let id = 1; id <= 5_001; id++) {
      insertRequestDetails({ requestId: id, redactedRequest: null, redactedResponse: null, payloadMode: null, payloadSha256: null, messageCount: null, toolNames: null, imageCount: null });
    }
    expect(getRequestDetailBundle(1).detail).not.toBeNull();
    expect(getRequestDetailBundle(5_001).detail).not.toBeNull();
  });

  test("deleteRequestDetailsOlderThan purges by date cutoff, not by count or age-in-memory", () => {
    insertRequestDetails({ requestId: 1, redactedRequest: null, redactedResponse: null, payloadMode: null, payloadSha256: null, messageCount: null, toolNames: null, imageCount: null });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    deleteRequestDetailsOlderThan(tomorrow);
    expect(getRequestDetailBundle(1).detail).toBeNull();
  });
});
