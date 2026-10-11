/**
 * Signs the dev console in through the real form so a later browser command
 * finds it already authenticated.
 *
 * This exists because verifying a dashboard surface is mandatory and the only
 * way to see the console is a sign-in with an operator credential. Driving that
 * by hand costs an agent several turns per session and puts the password in a
 * chat message, which `AGENTS.md` forbids. Here the credential comes from the
 * environment, the sign-in is the real production route, and nothing secret is
 * ever printed.
 *
 *   bun run dev:console-auth                      # vite dev server on 5173
 *   bun run dev:console-auth -- http://127.0.0.1:12800   # the built bundle
 *
 * Afterwards, plain `agent-browser` commands share the same browser session and
 * are already signed in. Re-running this is safe: an existing session is a
 * no-op.
 *
 * No production code is touched and no auth gate is weakened — this is the same
 * form an operator fills, reached with a credential from the environment.
 */
import { resolveBrowserAgentBinary, resolveDevAdminCredentials, signInToConsole, ConsoleBrowserAgent } from "./console-auth";

/** The vite dev server: serves `dashboard/src` with HMR, so an agent sees its own edits. */
const DEV_ORIGIN = "http://127.0.0.1:5173";
/** The gateway serves the built bundle from `dist/dashboard`, so edits need `dashboard:build`. */
const BUILT_ORIGIN = "http://127.0.0.1:12800";

async function main(): Promise<void> {
  // `Bun.argv` is [executable, script, ...args], so the first real argument is
  // index 2. Reading index 3 here silently ignored an explicit origin and signed
  // the browser into the default one instead — the caller believes it asked for
  // the built bundle and is measuring a different origin.
  const origin = Bun.argv[2]?.trim() || DEV_ORIGIN;
  const creds = resolveDevAdminCredentials();

  // Checked before touching the browser: a missing gateway otherwise surfaces as
  // a sign-in form that never resolves, which reads as a broken console.
  const healthy = await isReachable(`${origin}/health`);
  if (!healthy) {
    console.error(
      `No dev gateway answering at ${origin}.\n` +
        `Start the stack in this session with:  ! bun run dev:stack\n` +
        `(${DEV_ORIGIN} serves dashboard/src with HMR; ${BUILT_ORIGIN} serves the built bundle.)`,
    );
    process.exit(1);
  }

  const agent = new ConsoleBrowserAgent(resolveBrowserAgentBinary());
  try {
    await signInToConsole(agent, creds, origin);
  } catch (error) {
    // One attempt only, deliberately: `src/console/auth/lockout.ts` locks the
    // account after repeated failures, so a retry loop can lock the operator
    // out of their own dev console.
    console.error(`Console sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`Console session ready at ${origin}/console`);
  console.log("Plain agent-browser commands now share this browser and are signed in.");
}

/** A loopback health probe. Absence means the stack is down, not that auth failed. */
async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

await main();
