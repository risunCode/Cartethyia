import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";

export const CODEX_RESERVED_METADATA_KEYS = [
  "session_id",
  "thread_id",
  "window_id",
  "turn_id",
  "parent_turn_id",
] as const;

interface CodexIdentity {
  readonly session_id: string;
  readonly thread_id: string;
  readonly window_id: string;
  readonly turn_id: string;
  readonly parent_turn_id?: string;
}

interface CodexResidencyOptions {
  readonly override?: string;
  readonly accessToken?: string;
}

function homeDirectory(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
}

export function getCodexInstallIdPath(homeDir = homeDirectory()): string {
  return join(homeDir, ".cartethyia", "codex-install-id");
}

export async function getCodexInstallId(path = getCodexInstallIdPath()): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
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
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
    return (await readFile(path, "utf8")).trim();
  }
}
export function createCodexIdentity(
  sessionId: string = randomUUID(),
  parentTurnId?: string,
): CodexIdentity {
  return {
    session_id: sessionId,
    thread_id: randomUUID(),
    window_id: randomUUID(),
    turn_id: randomUUID(),
    ...(parentTurnId === undefined ? {} : { parent_turn_id: parentTurnId }),
  };
}

export function filterCodexMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set<string>(CODEX_RESERVED_METADATA_KEYS);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !reserved.has(key)));
}

export function getCodexAccountId(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  const nested = claims?.["https://api.openai.com/auth"];
  const nestedClaims =
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
  const value = claims?.["chatgpt_account_id"] ?? nestedClaims?.["chatgpt_account_id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getCodexResidency(options: CodexResidencyOptions): string | undefined {
  const override = options.override?.trim();
  if (override !== undefined && override.length > 0) return override;
  const claims =
    options.accessToken === undefined ? undefined : decodeJwtPayload(options.accessToken);
  const authClaim = claims?.["https://api.openai.com/auth"];
  const auth =
    authClaim !== null && typeof authClaim === "object"
      ? (authClaim as Record<string, unknown>)
      : undefined;
  for (const claim of [
    auth?.["chatgpt_data_residency"],
    auth?.["chatgpt_compute_residency"],
    claims?.["chatgpt_data_residency"],
    claims?.["chatgpt_compute_residency"],
  ]) {
    if (typeof claim !== "string") continue;
    const residency = claim.trim();
    if (residency.length > 0) return residency;
  }
  return undefined;
}

// Verified: no production importer — sole importer was adapter.test.ts,
// now updated to ./residency.

/**
 * Codex credential-store selection.
 *
 * `cli_auth_credentials_store` controls where Codex OAuth/API-key material is
 * cached locally:
 * - `file`    → `~/.codex/auth.json` (plaintext — treat like a password)
 * - `keyring` → OS credential store (platform keyring)
 * - `auto`    → prefer keyring when available, otherwise file
 *
 * Cartethyia models this store policy explicitly so account-type decisions
 * (ChatGPT-OAuth vs API-key) remain non-fungible even though both dispatch
 * over the Responses wire family. Enterprise scoped tokens and workload-
 * identity federation are ChatGPT-OAuth-family credentials, not API-key.
 */

type CliAuthCredentialsStore = "file" | "keyring" | "auto";

export const CODEX_AUTH_FILE_RELATIVE = ".codex/auth.json";

/**
 * Resolve the OS path for file-backed Codex auth.
 * When `homeDir` is omitted, uses `HOME` / `USERPROFILE` env or `~`.
 */
export function getCodexAuthFilePath(homeDir?: string): string {
  const home = homeDir ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? "~";
  const normalizedHome = home.endsWith("/") ? home.slice(0, -1) : home;
  return `${normalizedHome}/${CODEX_AUTH_FILE_RELATIVE}`;
}

interface CodexStoreResolution {
  /** Effective physical store after resolving `auto`. */
  readonly resolved: "file" | "keyring";
  /** File path when `resolved` is `file`; undefined for `keyring`. */
  readonly filePath?: string;
  /** Original requested value. */
  readonly requested: CliAuthCredentialsStore;
}

/**
 * Resolve a requested store value against platform capability.
 *
 * `hasKeyring` indicates whether the OS credential store is available in this
 * environment. Cartethyia never probes the keyring directly; the caller supplies
 * the capability flag (derived from an explicit feature check or test fake).
 */
export function resolveCodexStore(
  requested: CliAuthCredentialsStore,
  context: { hasKeyring: boolean; homeDir?: string },
): CodexStoreResolution {
  if (requested === "file") {
    return {
      resolved: "file",
      filePath: getCodexAuthFilePath(context.homeDir),
      requested,
    };
  }
  if (requested === "keyring") {
    return { resolved: "keyring", requested };
  }
  // auto
  if (context.hasKeyring) {
    return { resolved: "keyring", requested };
  }
  return {
    resolved: "file",
    filePath: getCodexAuthFilePath(context.homeDir),
    requested,
  };
}

