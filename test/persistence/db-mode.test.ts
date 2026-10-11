import { describe, expect, test } from "bun:test";
import { resolveDataDir, resolveDbMode } from "../../src/persistence/db-mode";

/**
 * `CARTETHYIA_DB_MODE` is required, and these tests pin *why* that is load
 * bearing rather than merely tidy.
 *
 * It used to default to `full`, so the one key carried three answers: the code
 * said `full`, `.env.example` said `lite`, and the `bun setup` prompt offered
 * `lite`. The code's answer is the one an environment that sets nothing gets, so
 * a clone without a `.env` booted in Full mode and failed on a missing
 * `DATABASE_URL` — while the documented intent was the self-contained Lite path.
 *
 * The modes are also genuinely different databases with different migration
 * sets, so guessing one is not a harmless convenience: it silently chooses which
 * migrations an operator's data is read against. Hence no default, and a message
 * that names the command which writes it.
 */
describe("resolveDbMode", () => {
  test("an absent key throws and names the command that writes it", () => {
    // Naming `bun setup` is the actionable half; the mode name alone would send
    // an operator looking for a value nobody documented as mandatory.
    expect(() => resolveDbMode({})).toThrow(/bun setup/);
  });

  test("a blank value is refused, not read as a default", () => {
    // A `.env` line left as `CARTETHYIA_DB_MODE=` is what a half-finished setup
    // actually leaves behind, and it must not boot.
    expect(() => resolveDbMode({ CARTETHYIA_DB_MODE: "   " })).toThrow(
      /CARTETHYIA_DB_MODE is required/,
    );
  });

  test("surrounding whitespace is trimmed before the mode is read", () => {
    expect(resolveDbMode({ CARTETHYIA_DB_MODE: " lite\n" })).toBe("lite");
  });

  test("both modes are accepted verbatim", () => {
    expect(resolveDbMode({ CARTETHYIA_DB_MODE: "lite" })).toBe("lite");
    expect(resolveDbMode({ CARTETHYIA_DB_MODE: "full" })).toBe("full");
  });

  test("an unknown value throws and echoes what was given", () => {
    // Echoing the received value is what makes a typo diagnosable: `sqllite`
    // reported back beats "must be lite or full".
    expect(() => resolveDbMode({ CARTETHYIA_DB_MODE: "sqllite" })).toThrow(/sqllite/);
  });
});

describe("resolveDataDir", () => {
  test("an explicit override wins over every platform convention", () => {
    expect(resolveDataDir({ CARTETHYIA_DATA_DIR: "D:/cartethyia-data" })).toBe("D:/cartethyia-data");
  });

  test("a blank override falls through to the platform default", () => {
    // Otherwise `CARTETHYIA_DATA_DIR=` would resolve to the empty string and the
    // SQLite file would be created at the filesystem root.
    const dir = resolveDataDir({ CARTETHYIA_DATA_DIR: "  " });
    expect(dir.length).toBeGreaterThan(0);
    expect(dir).not.toBe("  ");
  });
});
