import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Console credentials (environment only)
// ---------------------------------------------------------------------------

export interface AdminCredentials {
  readonly user: string;
  readonly password: string;
}

/**
 * Resolves the dev console admin from the environment.
 *
 * Fails closed and never prompts: this is read by dev tooling that drives a real
 * browser through the real sign-in form, so a missing password is a setup mistake
 * the operator should see named, not a value the tool should invent. A defaulted
 * password would turn a misconfigured environment into a silent wrong-account
 * sign-in — and one that a later reader could mistake for a working login.
 */
export function resolveDevAdminCredentials(): AdminCredentials {
  const user = process.env.CARTETHYIA_DEV_ADMIN_USER?.trim() || "admin";
  const password = process.env.CARTETHYIA_DEV_ADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "CARTETHYIA_DEV_ADMIN_PASSWORD is required — dev console sign-in goes through the real console form, so the credential must come from the environment",
    );
  }
  return { user, password };
}

// ---------------------------------------------------------------------------
// Sign-in (the real production path)
// ---------------------------------------------------------------------------

/**
 * The slice of a browser driver that signing in needs. `BrowserAgent` in
 * `visual-baseline.ts` satisfies it structurally, so the baseline and the
 * interactive session command share one sign-in implementation instead of two
 * that drift.
 */
export interface ConsoleSignInBrowser {
  open(url: string, extraArgs?: readonly string[]): Promise<void>;
  evalObject<T>(script: string): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForText(text: string): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
}

/**
 * Signs the browser in through the real form.
 *
 * The page resolves into one of three terminal states, and the middle one is the
 * reason this is not a two-field fill: on a fresh dev database the console lands
 * on `/console/setup`, not `/console/login`, because no account exists yet. The
 * first-boot wizard is the only real way an account comes to be, so filling
 * `#login-username` there silently does nothing and the caller concludes the
 * console is broken. `shell` is checked first so an already-signed-in session is
 * a no-op rather than a re-login.
 *
 * The session check is async, so this waits for a known state rather than racing
 * a not-yet-rendered form.
 */
export async function signInToConsole(
  browser: ConsoleSignInBrowser,
  creds: AdminCredentials,
  origin: string,
): Promise<void> {
  await browser.open(`${origin}/console`);

  const deadline = Date.now() + 20_000;
  let state = { login: false, setup: false, shell: false };
  for (;;) {
    state = await browser.evalObject<{ login: boolean; setup: boolean; shell: boolean }>(
      `({
        login: !!document.querySelector("#login-username"),
        setup: !!document.querySelector("#setup-username"),
        shell: !!document.querySelector('button[aria-label="Sign out"]'),
      })`,
    );
    if (state.shell || state.login || state.setup) break;
    if (Date.now() > deadline) throw new Error("sign-in page never resolved into a known state");
    await Bun.sleep(300);
  }

  if (state.shell) return;

  if (state.setup) {
    await browser.fill("#setup-username", creds.user);
    await browser.fill("#setup-password", creds.password);
    await browser.fill("#setup-confirm", creds.password);
    await browser.click('button[type="submit"]');
    await browser.waitForText("Sign in");
  }

  await browser.fill("#login-username", creds.user);
  await browser.fill("#login-password", creds.password);
  await browser.click('button[type="submit"]');
  // The signed-in shell has no visible "Sign out" text (the icon-only button
  // carries it as an aria-label), so wait on the selector, not visible text.
  await browser.waitForSelector('button[aria-label="Sign out"]');
}

// ---------------------------------------------------------------------------
// Browser agent CLI
// ---------------------------------------------------------------------------

/**
 * Resolves the `agent-browser` executable. `CARTETHYIA_BROWSER_AGENT` wins;
 * otherwise the npm-global binary is located (a `.cmd` shim on Windows cannot
 * be exec'd directly, so the underlying `.exe` is found), and on POSIX the
 * executable shell shim in `PATH` is used.
 */
export function resolveBrowserAgentBinary(): string {
  const override = process.env.CARTETHYIA_BROWSER_AGENT?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const candidate = appData
      ? resolve(appData, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe")
      : undefined;
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "agent-browser";
}

interface AgentResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * One browser-agent session driven through its CLI. Every command is a fresh
 * subprocess against the same named session, so the browser stays up across
 * calls and each command's stdout is a self-contained answer.
 *
 * `agent-browser` is a client/daemon split: the first command spawns a
 * long-lived session daemon that owns Chrome, and that daemon **inherits the
 * client's stdout pipe write-end**. Reading stdout as a pipe therefore never
 * reaches EOF after the client exits. Each command redirects stdout/stderr to
 * a scratch file instead (a file EOFs by size, not by fd count) and is read
 * back after the process exits.
 *
 * `extraFlags` is prepended to every command and is the whole knob for session
 * identity and lifetime:
 *
 * - Omitted (the interactive default): the CLI's own default session, with its
 *   one-hour idle timeout. The agent's own plain `agent-browser` commands then
 *   land in the same browser, already signed in — which is the point.
 * - `--idle-timeout` / `--session`: for a batch caller that owns the browser
 *   start to finish and wants it gone when it exits. Each `--session` is
 *   isolated with its own cookies, so naming one here means nothing outside it
 *   sees the sign-in.
 */
export class ConsoleBrowserAgent implements ConsoleSignInBrowser {
  protected readonly scratchDir = mkdtempSync(join(tmpdir(), "cartethyia-console-"));
  private seq = 0;

  constructor(
    protected readonly bin: string,
    private readonly extraFlags: readonly string[] = [],
  ) {}

  async run(args: readonly string[], stdin?: string, timeoutMs = 90_000): Promise<AgentResult> {
    const outPath = join(this.scratchDir, `out-${this.seq++}`);
    const errPath = join(this.scratchDir, `err-${this.seq++}`);
    const base = [this.bin, ...this.extraFlags];
    const proc = Bun.spawn([...base, ...args], {
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: Bun.file(outPath),
      stderr: Bun.file(errPath),
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const outcome = await Promise.race([
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout") {
      proc.kill();
      throw new Error(`agent-browser ${args[0]} timed out after ${timeoutMs}ms`);
    }
    const out = readFileSync(outPath, "utf8").trim();
    const err = readFileSync(errPath, "utf8").trim();
    rmSync(outPath, { force: true });
    rmSync(errPath, { force: true });
    return { code: outcome.code, out, err };
  }

  protected async must(args: readonly string[], stdin?: string, timeoutMs?: number): Promise<string> {
    const result = await this.run(args, stdin, timeoutMs);
    if (result.code !== 0) {
      throw new Error(`agent-browser ${args[0]} failed (${result.code}): ${(result.err || result.out).slice(0, 600)}`);
    }
    return result.out;
  }

  /** Evaluates a script whose last expression is a JSON-serialisable object. */
  async evalObject<T>(script: string): Promise<T> {
    const out = await this.must(["eval", "--stdin"], script, 120_000);
    const parsed: unknown = JSON.parse(out);
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as T;
  }

  async open(url: string, extraArgs: readonly string[] = []): Promise<void> {
    await this.must([...extraArgs, "open", url], undefined, 120_000);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.must(["fill", selector, value]);
  }

  async click(selector: string): Promise<void> {
    await this.must(["click", selector]);
  }

  async waitForText(text: string): Promise<void> {
    await this.must(["wait", "--text", text], undefined, 60_000);
  }

  /** Polls until `selector` exists, so a shell state with no visible marker text is still detectable. */
  async waitForSelector(selector: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const present = await this.evalObject<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (present) return;
      if (Date.now() > deadline) throw new Error(`selector never appeared: ${selector}`);
      await Bun.sleep(300);
    }
  }
}
