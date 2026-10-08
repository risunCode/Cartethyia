/**
 * Runtime settings: how a stored preference bag becomes the response an
 * operator's console reads, and how the data plane reads the same bag.
 *
 * The interesting part is not the happy path — it is the two-key PonyTail
 * shape, because two surfaces read it and they disagreed.
 *
 * The original comment in `store.ts` claimed a "legacy bag" from a pre-flag era,
 * where only `ponyTailLevel` was stored and any level meant on. Measured against
 * history, that era never existed: `ponyTailLevel` and `ponyTailEnabled` were
 * introduced together in `8d1642d0`, and neither key appears anywhere in `src/`
 * before it. So the fallback was not preserving old data.
 *
 * What it actually did was turn a *current* dashboard interaction into consent.
 * The compression card lets an operator choose a strength while the toggle is
 * still off, and that control sends `{ponyTailLevel}` with no flag. The
 * fallback read that write as "enabled", so the console reported the directive
 * as on — while the dispatch gate in `tenant-preferences.ts` requires
 * `ponyTailEnabled === true` and injected nothing. The operator saw a feature
 * turned on that did no work. RTK, the symmetric control with identical UI, has
 * no such fallback and never had the bug.
 *
 * These tests hold both surfaces to one answer: the enable flag is the only
 * thing that turns the directive on, and a stored level is not consent.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/postgres";
import { consoleSettings } from "../../src/persistence/schema";
import { DrizzleRuntimeSettingsStore } from "../../src/console/settings/store";
import { DrizzlePreferencesReader } from "../../src/persistence/tenant-preferences";
import { dbDescribe } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

/**
 * The data plane's own gate, restated.
 *
 * This is the decision `applyTenantPreferences` makes before it calls
 * `compressRequest`, kept here as one expression so the test asserts the
 * contract rather than a copy of the implementation drifting unnoticed.
 */
function dataPlaneInjects(
  level: "lite" | "full" | "ultra" | null | undefined,
  enabled: boolean | undefined,
): boolean {
  return enabled === true && level !== null && level !== undefined;
}

dbDescribe("runtime settings: the two-key ponyTail bag", () => {
  let world: GatewayWorld;
  const store = new DrizzleRuntimeSettingsStore(getDb(), "redis");
  const reader = new DrizzlePreferencesReader(getDb());

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** Writes a raw preferences bag, exactly as the dashboard's PATCH leaves it. */
  async function writeBag(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  async function read(): Promise<{ ponyTailEnabled: boolean; ponyTailLevel: string }> {
    const settings = await store.get(world.tenantId);
    return { ponyTailEnabled: settings.ponyTailEnabled, ponyTailLevel: settings.ponyTailLevel };
  }

  test("a level with no flag is OFF — picking a strength is not consent", async () => {
    // The dashboard's strength dropdown writes exactly this shape while the
    // toggle is off. It must not switch the directive on.
    await writeBag({ ponyTailLevel: "ultra" });
    const settings = await read();
    expect(settings.ponyTailEnabled).toBe(false);
    expect(settings.ponyTailLevel).toBe("ultra");
  });

  test("the flag alone enables, at the default intensity", async () => {
    await writeBag({ ponyTailEnabled: true });
    expect(await read()).toEqual({ ponyTailEnabled: true, ponyTailLevel: "full" });
  });

  test("the flag plus a level enables at that level", async () => {
    await writeBag({ ponyTailEnabled: true, ponyTailLevel: "ultra" });
    expect(await read()).toEqual({ ponyTailEnabled: true, ponyTailLevel: "ultra" });
  });

  test("an explicit off wins over a stored level", async () => {
    // The console keeps the level so the intensity survives a re-enable.
    await writeBag({ ponyTailEnabled: false, ponyTailLevel: "ultra" });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "ultra" });
  });

  test("a bag with no ponyTail keys at all is off", async () => {
    await writeBag({});
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });

  test("an invalid level does not enable the feature", async () => {
    // A corrupt or future value must not read as consent.
    await writeBag({ ponyTailLevel: "extreme" });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });

  test("a null level is off", async () => {
    await writeBag({ ponyTailLevel: null });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });

  test("the raw reader hands the data plane the bag verbatim", async () => {
    // Why the two surfaces could disagree: this reader does no normalisation at
    // all. Whatever the console wrote is what the dispatch gate sees.
    await writeBag({ ponyTailLevel: "ultra" });
    const prefs = await reader.readPreferences(world.tenantId);
    expect(prefs).toEqual({ ponyTailLevel: "ultra" });
    expect(prefs?.ponyTailEnabled).toBeUndefined();
  });

  test("the two surfaces agree: a dropdown-only write injects nothing", async () => {
    // The regression this file exists for. Before the fix the console reported
    // this row as enabled while dispatch injected nothing — a feature the
    // operator could see switched on that did no work at all.
    await writeBag({ ponyTailLevel: "ultra" });

    const consoleView = await read();
    const prefs = await reader.readPreferences(world.tenantId);

    expect(consoleView.ponyTailEnabled).toBe(false);
    expect(dataPlaneInjects(prefs?.ponyTailLevel, prefs?.ponyTailEnabled)).toBe(
      consoleView.ponyTailEnabled,
    );
  });

  test("the two surfaces agree: an enabled row injects", async () => {
    await writeBag({ ponyTailEnabled: true, ponyTailLevel: "ultra" });

    const consoleView = await read();
    const prefs = await reader.readPreferences(world.tenantId);

    expect(consoleView.ponyTailEnabled).toBe(true);
    expect(dataPlaneInjects(prefs?.ponyTailLevel, prefs?.ponyTailEnabled)).toBe(
      consoleView.ponyTailEnabled,
    );
  });
});
