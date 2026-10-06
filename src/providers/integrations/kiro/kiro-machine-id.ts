/**
 * Kiro machine identity.
 *
 * The upstream binds a credential to the device it was first seen from, and a
 * credential that presents a different device on every request — or the same
 * device as every other account — reads as account sharing rather than as one
 * machine running one client. Two shapes in particular are worse than sending
 * nothing at all:
 *
 *  * a constant, because every account in every deployment then claims to be
 *    the same machine, and the constant is identical for every operator;
 *  * a per-request random value, because one account appears to move between
 *    devices on every call.
 *
 * So the identity is derived once per credential from material that is stable
 * for that credential and distinct between credentials, then frozen into the
 * account's `auth_state` so a refresh — which rotates the refresh token, and
 * with it any value derived from that token — cannot silently change it.
 *
 * The salts below are wire facts: they are what the observed client hashes.
 * They are deliberately different per credential family, because an API key and
 * a refresh token for the same account must not derive the same device id.
 */
import { createHash } from "node:crypto";

/** Prefix the observed client hashes for an OAuth (refresh-token) credential. */
const OAUTH_SALT = "KotlinNativeAPI/";
/** Prefix the observed client hashes for an API-key credential. */
const API_KEY_SALT = "KiroAPIKey/";
/** Prefix for the fallback used when neither material is available. */
const FALLBACK_SALT = "KiroFallback/";

/** Length of a machine id, in hex characters. */
const MACHINE_ID_LENGTH = 64;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Normalizes a machine id supplied from outside the derivation.
 *
 * A 64-character hex value is taken as-is; a 32-character hex value (a bare
 * UUID with its dashes removed) is doubled, which is the shape the upstream
 * accepts for that input. Anything else is rejected rather than sent, because a
 * malformed device id is itself a signal.
 */
export function normalizeMachineId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length === MACHINE_ID_LENGTH && /^[0-9a-f]+$/.test(value)) return value;
  if (value.length === MACHINE_ID_LENGTH / 2 && /^[0-9a-f]+$/.test(value)) return `${value}${value}`;
  return undefined;
}

/** Derives the machine id an OAuth credential presents. */
export function deriveOAuthMachineId(refreshToken: string): string {
  return sha256Hex(`${OAUTH_SALT}${refreshToken}`);
}

/** Derives the machine id an API-key credential presents. */
export function deriveApiKeyMachineId(apiKey: string): string {
  return sha256Hex(`${API_KEY_SALT}${apiKey}`);
}

/**
 * Derives the fallback machine id for a credential with no derivable material.
 *
 * Derived from the account id rather than from randomness so that the same
 * account is the same machine after a restart. A random fallback would give
 * every account a new device on every boot, which is the same defect as
 * deriving a new one per refresh.
 */
export function fallbackMachineId(accountId: string): string {
  return sha256Hex(`${FALLBACK_SALT}${accountId}`);
}

/**
 * Resolves the device identity one account presents, from its stored
 * configuration.
 *
 * **Every surface that talks to the upstream calls this** — dispatch, usage, the
 * model catalog. That is the whole point: the upstream correlates a credential
 * against one device, so a single account reporting one device at dispatch and
 * another while reading its own quota is exactly the signal this module exists
 * to eliminate. Two call sites deriving independently is how they drift.
 *
 * `frozen` (written by the login flow from material that outlives a token
 * rotation) always wins. Everything else is a fallback for an account whose
 * stored configuration predates the field, and it is derived from values that
 * are stable for the account: the account id first, then the OIDC client id,
 * then the profile ARN, then the organization URL. Nothing that rotates with a
 * token is ever an input, because the access token is what dispatch has and it
 * is replaced on every refresh.
 */
export function machineIdForAuthState(
  authState: Readonly<Record<string, unknown>> | undefined,
  accountId?: string | undefined,
): string {
  const raw = authState ?? {};
  const frozen = normalizeMachineId(raw["machineId"]);
  if (frozen !== undefined) return frozen;
  const clientId = typeof raw["clientId"] === "string" ? raw["clientId"].trim() : "";
  const profileArn = typeof raw["profileArn"] === "string" ? raw["profileArn"].trim() : "";
  const startUrl = typeof raw["startUrl"] === "string" ? raw["startUrl"].trim() : "";
  return fallbackMachineId(accountId || clientId || profileArn || startUrl);
}
