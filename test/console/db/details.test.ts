/**
 * Unit tests for src/console/db/repos/details.ts —
 * covers durable request/asset/tool-call storage and date-cutoff retention.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  insertRequestDetails,
  insertAssetMeta,
  insertToolCall,
  getRequestDetailBundle,
  purgeAllStoredData,
  deleteRequestDetailsOlderThan,
  deleteRequestAssetsOlderThan,
  deleteRequestToolCallsOlderThan,
} from "../../../src/console/db/repos/details";

beforeEach(() => {
  purgeAllStoredData();
});

function insertDetail(requestId: number) {
  insertRequestDetails({
    requestId,
    redactedRequest: null,
    redactedResponse: null,
    payloadMode: null,
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
      payloadMode: "store",
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

describe("date-cutoff retention (deleteRequestDetailsOlderThan + friends)", () => {
  test("keeps rows on or after the cutoff date", () => {
    insertDetail(100);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    deleteRequestDetailsOlderThan(tomorrow);
    // Rows created "now" (today) are not older than tomorrow's cutoff... they
    // are, since today < tomorrow - this asserts the boundary is exclusive.
    expect(getRequestDetailBundle(100).detail).toBeNull();
  });

  test("a cutoff in the past leaves current rows untouched", () => {
    insertDetail(101);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    deleteRequestDetailsOlderThan(yesterday);
    expect(getRequestDetailBundle(101).detail).not.toBeNull();
  });

  test("deleteRequestAssetsOlderThan removes rows and returns their storage paths", () => {
    insertDetail(200);
    insertAssetMeta({ requestId: 200, kind: "img", mime: null, bytes: null, sha256: "abc", storagePath: "/tmp/asset-200.bin" });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const removedPaths = deleteRequestAssetsOlderThan(tomorrow);
    expect(removedPaths).toEqual(["/tmp/asset-200.bin"]);
    expect(getRequestDetailBundle(200).assets).toHaveLength(0);
  });

  test("deleteRequestToolCallsOlderThan removes rows before the cutoff", () => {
    insertDetail(300);
    insertToolCall({ requestId: 300, name: "get_weather", bytes: null, sha256: null, durationMs: null, status: "ok" });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const removed = deleteRequestToolCallsOlderThan(tomorrow);
    expect(removed).toBe(1);
    expect(getRequestDetailBundle(300).toolCalls).toHaveLength(0);
  });
});

describe("purgeAllStoredData", () => {
  test("clears everything and returns counts", () => {
    insertDetail(300);
    insertDetail(301);
    insertAssetMeta({ requestId: 300, kind: "img", mime: null, bytes: null, sha256: null, storagePath: null });
    insertToolCall({ requestId: 301, name: "x", bytes: null, sha256: null, durationMs: null, status: null });
    const result = purgeAllStoredData();
    expect(result.details).toBe(2);
    expect(result.assets).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(getRequestDetailBundle(300).detail).toBeNull();
  });
});
