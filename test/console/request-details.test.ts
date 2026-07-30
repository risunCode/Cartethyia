import { afterEach, describe, expect, test } from "bun:test";
import { getRequestDetailBundle, insertRequestDetails, purgeAllStoredData, purgeRequestDetailTracking } from "../../src/console/db/repos/details";

afterEach(() => { purgeAllStoredData(); });

describe("request detail retention", () => {
  test("caps detail state and purges entries older than its TTL", () => {
    for (let id = 1; id <= 5_001; id++) insertRequestDetails({ requestId: id, redactedRequest: null, redactedResponse: null, payloadPath: null, payloadSha256: null, messageCount: null, toolNames: null, imageCount: null });
    expect(getRequestDetailBundle(1).detail).toBeNull();
    expect(getRequestDetailBundle(5_001).detail).not.toBeNull();
    purgeRequestDetailTracking(Date.now() + 31 * 60_000);
    expect(getRequestDetailBundle(5_001).detail).toBeNull();
  });
});
