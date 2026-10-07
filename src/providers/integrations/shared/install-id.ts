/**
 * Per-installation identity ids, shared by the providers that stamp one on
 * their upstream requests (Claude, Codex, Grok).
 *
 * Three things went wrong when each provider owned this logic, and all three
 * are fixed here:
 *
 * 1. The id was written under `$HOME/.cartethyia`. In the container the process
 *    drops to uid 10001 via `setpriv`, which does not change `HOME` — so it kept
 *    pointing at `/root` and every write failed with `EACCES`. The location is
 *    now a list of candidates tried in order, and `$HOME` is only one of them.
 *
 * 2. A failed write threw, and the caller let it escape into dispatch: a
 *    cosmetic telemetry identity took the whole provider offline. A failure to
 *    persist now degrades to an in-process id and a one-time warning.
 *
 * 3. Three copies of the same read/mkdir/open sequence had drifted apart. There
 *    is one now.
 *
 * The id is deliberately best-effort. It is an identity hint for the upstream,
 * not a credential: losing it changes how a machine is counted, never whether a
 * request can be served.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../../../observability/logger";

/** Overrides the directory the install ids are persisted in. */
const INSTALL_ID_DIR_ENV = "CARTETHYIA_INSTALL_ID_DIR";

/**
 * Candidate directories for install ids, most specific first.
 *
 * Every candidate is attempted, not just the first: an explicit override or a
 * `$HOME` that exists but is not writable must not be worse than having no
 * location at all. `./data` is last because it is the one a container is most
 * likely to have made writable, and it is relative to the working directory the
 * process was started in.
 */
function installIdDirectories(): readonly string[] {
  const candidates: string[] = [];
  const configured = process.env[INSTALL_ID_DIR_ENV]?.trim();
  if (configured && configured.length > 0) candidates.push(configured);
  const home = (process.env["HOME"] ?? process.env["USERPROFILE"])?.trim();
  if (home && home.length > 0) candidates.push(join(home, ".cartethyia"));
  candidates.push(join("data", ".cartethyia"));
  return candidates;
}

/**
 * Ids minted when no candidate could be written. Kept for the life of the
 * process so a request does not see a different identity than the one before
 * it, which is the least surprising behaviour available when persistence is
 * impossible.
 */
const inMemoryIds = new Map<string, string>();
const warnedPaths = new Set<string>();

function fallbackId(key: string, path: string, reason: unknown): string {
  const existing = inMemoryIds.get(key);
  if (existing !== undefined) return existing;
  const id = randomUUID();
  inMemoryIds.set(key, id);
  if (!warnedPaths.has(key)) {
    warnedPaths.add(key);
    const message = reason instanceof Error ? reason.message : String(reason);
    log.warn(
      `[install-id] could not persist "${path}" (${message}); using an id that ` +
        `lasts only for this process. Set ${INSTALL_ID_DIR_ENV} to a writable ` +
        `directory to keep a stable identity across restarts.`,
    );
  }
  return id;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** Reads an existing id, or creates one, at a single path. Throws on failure. */
async function readOrCreateAt(path: string): Promise<string | undefined> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch (error) {
    // A missing file is the normal first-run path; anything else (a permission
    // error, an unreadable directory) means this location is unusable.
    if (!isErrno(error, "ENOENT")) throw error;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${id}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return id;
  } catch (error) {
    // A concurrent first request won the create; adopt its id rather than
    // minting a second one for the same installation.
    if (isErrno(error, "EEXIST")) {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing.length > 0) return existing;
    }
    throw error;
  }
}

/**
 * Reads the persisted id, creating it on first use.
 *
 * `path` is a seam for tests and for callers that resolve their own location;
 * when omitted, each {@link installIdDirectories} candidate is tried in order
 * and the first that works wins.
 */
export async function getOrCreateInstallId(name: string, path?: string): Promise<string> {
  const candidates = path !== undefined ? [path] : installIdDirectories().map((dir) => join(dir, `${name}-install-id`));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const id = await readOrCreateAt(candidate);
      if (id !== undefined) return id;
    } catch (error) {
      lastError = error;
    }
  }
  return fallbackId(`${name}:${candidates.join("|")}`, candidates[0] ?? name, lastError);
}

