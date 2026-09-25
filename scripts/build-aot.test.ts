/**
 * AOT build contract test.
 *
 * The AOT script must terminate synchronously on Bun.build resolve
 * (never wait for DB/Redis connections spawned by boot side-effects) and
 * must exit non-zero when the compiler reports diagnostics. Everything
 * else — logs, entrypoint list — is asserted by `bun run build:aot` on
 * every CI run through the real Bun.build call and is not re-mocked here.
 */
import { describe, it, expect } from "bun:test";
import { buildAOT } from "./build-aot";

interface FakeBuildLog {
  readonly message: string;
}

class Fixture {
  buildCalls = 0;
  exitCode = 0;
  logs: FakeBuildLog[] = [];
  private shouldThrow = false;
  fail(): this {
    this.shouldThrow = true;
    return this;
  }
  withLogs(logs: FakeBuildLog[]): this {
    this.logs = logs;
    return this;
  }
  build = async (config: unknown) => {
    this.buildCalls++;
    this.lastConfig = config;
    if (this.shouldThrow) throw new Error("simulated build failure");
    return { logs: this.logs };
  };
  exit = (code: number): never => {
    this.exitCode = code;
    // Prevents test process from actually exiting; buildAOT swallows this
    // marker via its try/catch on process.exit.
    throw new Error(`process.exit(${code})`);
  };
  lastConfig: unknown = undefined;
}

async function run(fx: Fixture): Promise<void> {
  try {
    await buildAOT(fx.build, fx.exit);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("process.exit")) throw error;
  }
}

describe("AOT build contract", () => {
  it("exits 0 when Bun.build produces no diagnostics", async () => {
    const fx = new Fixture();
    await run(fx);
    expect(fx.buildCalls).toBe(1);
    expect(fx.exitCode).toBe(0);
  });

  it("exits 1 when Bun.build reports any diagnostic", async () => {
    const fx = new Fixture().withLogs([{ message: "type mismatch" }]);
    await run(fx);
    expect(fx.exitCode).toBe(1);
  });

  it("exits 1 when Bun.build throws", async () => {
    const fx = new Fixture().fail();
    await run(fx);
    expect(fx.exitCode).toBe(1);
  });

  it("invokes Bun.build with the pinned entrypoint, outdir, and target", async () => {
    const fx = new Fixture();
    await run(fx);
    const config = fx.lastConfig as
      | { entrypoints: readonly string[]; outdir: string; target: string }
      | undefined;
    expect(config?.entrypoints).toEqual(["src/main.ts"]);
    expect(config?.outdir).toBe("dist");
    expect(config?.target).toBe("bun");
  });
});
