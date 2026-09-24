import { describe, expect, test } from "bun:test";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import type { PoolRotation } from "../../src/network/pool/selector";

const POOLS = ["p0", "p1", "p2", "p3"];

/** One rotation admission: returns the chosen pool id and releases the slot. */
async function admitOnce(
  selector: NetworkPoolSelector,
  pools: readonly string[],
  rotation: PoolRotation,
  limitsByPool?: Record<string, number>,
): Promise<string> {
  const slot = await selector.tryAcquireAvailablePool(
    pools,
    "openai",
    limitsByPool,
    undefined,
    rotation,
  );
  if (!slot) throw new Error("expected an available pool");
  const poolId = slot.poolId;
  slot.release();
  return poolId;
}

describe("NetworkPoolSelector round-robin rotation", () => {
  test("rotateCount 2 gives each of 4 pools two admissions before advancing", async () => {
    const selector = new NetworkPoolSelector();
    const rotation: PoolRotation = { key: "tenant-a", rotateCount: 2 };
    const served: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      served.push(await admitOnce(selector, POOLS, rotation));
    }
    expect(served).toEqual(["p0", "p0", "p1", "p1", "p2", "p2", "p3", "p3"]);
  });

  test("rotateCount 2 over 2 pools does not starve either pool", async () => {
    const selector = new NetworkPoolSelector();
    const rotation: PoolRotation = { key: "tenant-b", rotateCount: 2 };
    const pools = ["p0", "p1"];
    const served: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      served.push(await admitOnce(selector, pools, rotation));
    }
    expect(served).toEqual(["p0", "p0", "p1", "p1"]);
  });

  test("rotateCount 1 cycles through every pool", async () => {
    const selector = new NetworkPoolSelector();
    const rotation: PoolRotation = { key: "tenant-c", rotateCount: 1 };
    const served: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      served.push(await admitOnce(selector, POOLS, rotation));
    }
    expect(served).toEqual(["p0", "p1", "p2", "p3", "p0", "p1", "p2", "p3"]);
  });

  test("a failed cooldown rejection consumes no rotation position", async () => {
    const selector = new NetworkPoolSelector();
    const rotation: PoolRotation = { key: "tenant-d", rotateCount: 1 };
    expect(await admitOnce(selector, POOLS, rotation)).toBe("p0");
    expect(await admitOnce(selector, POOLS, rotation)).toBe("p1");
    for (const poolId of POOLS) {
      await selector.flagProviderCooldown(poolId, "openai", 60_000, "test");
    }
    expect(
      await selector.tryAcquireAvailablePool(POOLS, "openai", undefined, undefined, rotation),
    ).toBeUndefined();
    for (const poolId of POOLS) {
      await selector.clearProviderCooldown(poolId, "openai");
    }
    // The head must still be p2 — the rejected attempt advanced nothing.
    expect(await admitOnce(selector, POOLS, rotation)).toBe("p2");
  });

  test("a failed at-capacity selection consumes no rotation position", async () => {
    const selector = new NetworkPoolSelector();
    const rotation: PoolRotation = { key: "tenant-e", rotateCount: 1 };
    const limits: Record<string, number> = { p0: 1, p1: 1, p2: 1, p3: 1 };
    const held: Array<() => void> = [];
    const served: string[] = [];
    for (let index = 0; index < POOLS.length; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        POOLS,
        "openai",
        limits,
        undefined,
        rotation,
      );
      if (!slot) throw new Error(`expected admission ${index}`);
      served.push(slot.poolId);
      held.push(slot.release);
    }
    expect(served).toEqual(POOLS);
    expect(
      await selector.tryAcquireAvailablePool(POOLS, "openai", limits, undefined, rotation),
    ).toBeUndefined();
    // Free p0 and p1: an unchanged head (p0) picks p0; an advanced head picks p1.
    held[0]?.();
    held[1]?.();
    expect(await admitOnce(selector, POOLS, rotation, limits)).toBe("p0");
  });
});
