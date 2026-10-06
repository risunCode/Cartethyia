import { randomUUID } from "node:crypto";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import { getOrCreateInstallId } from "../install-id";

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

export function getCodexInstallId(path?: string): Promise<string> {
  // No argument means "try the standard locations", which the shared resolver
  // does in order. Resolving one path here would skip the writable-directory
  // fallback the container depends on.
  return getOrCreateInstallId("codex", path);
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

