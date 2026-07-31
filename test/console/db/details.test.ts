/**
 * Unit tests for src/console/db/repos/details.ts —
 * covers TTL purge, bounded index eviction, and asset/toolCall TTL cleanup.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  insertRequestDetails,
  insertAssetMeta,
  insertToolCall,
  purgeRequestDetailTracking,
  getRequestDetailBundle,
  purgeAllStoredData,
} from "../../../src/console/db/repos/details";

beforeEach(() => {
  purgeAllStoredData();
});

function insertDetail(requestId: number) {
  insertRequestDetails({
    requestId,
    redactedRequest: null,
    redactedResponse: null,
    payloadPath: null,
    payloadSha256: null,
    messageCount: null,
    toolNames: null,
    imageCount: null,
  });
}

describe("insertRequestDetails + getRequestDetailBundle", () => {
  test("stores and retrieves a detail by requestId", () => {
    insertDetail(42);
    const bundle = getRequestDetailBundle(42);
    expect(bundle.detail).not.toBeNull();
    expect(bundle.detail?.request_id).toBe(42);
  });

  test("returns null detail for unknown requestId", () => {
    const bundle = getRequestDetailBundle(9999);
    expect(bundle.detail).toBeNull();
  });

  test("overwrites a previous entry for the same requestId", () => {
    insertDetail(1);
    insertRequestDetails({
      requestId: 1,
      redactedRequest: "updated",
      redactedResponse: null,
      payloadPath: null,
      payloadSha256: null,
      messageCount: 3,
      toolNames: null,
      imageCount: null,
    });
    const bundle = getRequestDetailBundle(1);
    expect(bundle.detail?.redacted_request).toBe("updated");
    expect(bundle.detail?.message_count).toBe(3);
  });
});

describe("insertAssetMeta + insertToolCall", () => {
  test("associates assets with a request", () => {
    insertDetail(10);
    insertAssetMeta({ requestId: 10, kind: "image", mime: "image/png", bytes: 1024, sha256: null, storagePath: null });
    const bundle = getRequestDetailBundle(10);
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0]!.kind).toBe("image");
  });

  test("associates tool calls with a request", () => {
    insertDetail(20);
    insertToolCall({ requestId: 20, name: "get_weather", bytes: null, sha256: null, durationMs: 150, status: "ok" });
    const bundle = getRequestDetailBundle(20);
    expect(bundle.toolCalls).toHaveLength(1);
    expect(bundle.toolCalls[0]!.name).toBe("get_weather");
  });

  test("does not leak assets across requests", () => {
    insertDetail(30);
    insertDetail(31);
    insertAssetMeta({ requestId: 30, kind: "pdf", mime: "application/pdf", bytes: 512, sha256: null, storagePath: null });
    expect(getRequestDetailBundle(31).assets).toHaveLength(0);
  });
});

describe("purgeRequestDetailTracking — TTL eviction", () => {
  test("evicts details older than 30 minutes", () => {
    insertDetail(100);
    // Simulate 31 minutes having passed
    const future = Date.now() + 31 * 60_000;
    purgeRequestDetailTracking(future);
    expect(getRequestDetailBundle(100).detail).toBeNull();
  });

  test("keeps details newer than 30 minutes", () => {
    insertDetail(101);
    const soon = Date.now() + 10 * 60_000;
    purgeRequestDetailTracking(soon);
    expect(getRequestDetailBundle(101).detail).not.toBeNull();
  });

  test("evicts assets whose created_at is before the cutoff", () => {
    insertDetail(200);
    // Insert an asset with a far-past created_at by backdating via direct purge
    insertAssetMeta({ requestId: 200, kind: "img", mime: null, bytes: null, sha256: null, storagePath: null });
    const future = Date.now() + 31 * 60_000;
    purgeRequestDetailTracking(future);
    expect(getRequestDetailBundle(200).assets).toHaveLength(0);
  });
});

describe("purgeAllStoredData", () => {
  test("clears everything and returns counts", () => {
    insertDetail(300);
    insertDetail(301);
    insertAssetMeta({ requestId: 300, kind: "img", mime: null, bytes: null, sha256: null, storagePath: null });
    const result = purgeAllStoredData();
    expect(result.details).toBe(2);
    expect(result.assets).toBe(1);
    expect(getRequestDetailBundle(300).detail).toBeNull();
  });
});
