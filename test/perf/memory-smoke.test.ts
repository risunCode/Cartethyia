/**
 * Non-blocking CI memory smoke gate. Run locally with `bun test test/perf/memory-smoke.test.ts`.
 * The 1 GiB process-RSS band catches runaway in-process retention without treating
 * workload-dependent allocator variation as a release failure in CI.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, useIsolatedDataDir } from "../console/helpers";

const memorySmoke = process.env.CI ? test.skip : test;

describe("memory smoke", () => {
  memorySmoke("stays within the documented RSS band after 200 mixed requests and GC", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    await Promise.all(Array.from({ length: 200 }, (_, index) => app.handle(new Request(
      index % 2 === 0 ? "http://localhost/health" : "http://localhost/console/api/health/metrics",
      index % 2 === 0 ? undefined : { headers: { cookie } },
    ))));
    const gc = await app.handle(new Request("http://localhost/console/api/health/gc", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    const snapshot = await app.handle(new Request("http://localhost/console/api/health/metrics", { headers: { cookie } }));
    const metrics = await snapshot.json() as { memoryUsedMb: number };

    expect(gc.status).toBe(200);
    expect(metrics.memoryUsedMb).toBeLessThan(1_024);
  });
});
