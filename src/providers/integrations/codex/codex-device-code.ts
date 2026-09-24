import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "../../authentication/oauth-client";

export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_DEVICE_MAX_POLLS = 120;

interface CodexDeviceStart {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
}

interface CodexDeviceAuthorization {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}

/** Validates persisted provider-private device state read back from the flow store. */
export function parseCodexDeviceStart(value: Record<string, unknown>): CodexDeviceStart | undefined {
  const { deviceAuthId, userCode, intervalSeconds } = value;
  if (typeof deviceAuthId !== "string" || typeof userCode !== "string") return undefined;
  if (typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds)) return undefined;
  return { deviceAuthId, userCode, intervalSeconds: Math.max(0, intervalSeconds) };
}

interface DeviceUserCodeResponse {
  device_auth_id?: unknown;
  user_code?: unknown;
  interval?: unknown;
}
interface DeviceTokenResponse {
  authorization_code?: unknown;
  code_verifier?: unknown;
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json", accept: "application/json" };
}

export async function startCodexDeviceAuth(
  clientId: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<CodexDeviceStart> {
  const response = await fetchFn(CODEX_DEVICE_USERCODE_URL, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) throw new Error(`Codex device authorization failed (${response.status})`);
  const body = (await response.json()) as DeviceUserCodeResponse;
  if (typeof body.device_auth_id !== "string" || typeof body.user_code !== "string")
    throw new Error("Codex device authorization returned an invalid response");
  const interval =
    typeof body.interval === "number" && Number.isFinite(body.interval)
      ? Math.max(0, body.interval)
      : 5;
  return { deviceAuthId: body.device_auth_id, userCode: body.user_code, intervalSeconds: interval };
}

export async function pollCodexDeviceAuth(
  device: CodexDeviceStart,
  fetchFn: FetchLike = globalThis.fetch,
  sleepFn: (milliseconds: number) => Promise<void> = (milliseconds) =>
    delay(milliseconds).then(() => undefined),
): Promise<CodexDeviceAuthorization> {
  for (let poll = 0; poll < CODEX_DEVICE_MAX_POLLS; poll += 1) {
    await sleepFn((device.intervalSeconds + 3) * 1000);
    const response = await fetchFn(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    });
    if (response.status === 403 || response.status === 404) continue;
    if (!response.ok) throw new Error(`Codex device polling failed (${response.status})`);
    const body = (await response.json()) as DeviceTokenResponse;
    if (typeof body.authorization_code === "string" && typeof body.code_verifier === "string")
      return { authorizationCode: body.authorization_code, codeVerifier: body.code_verifier };
  }
  throw new Error("Codex device authorization timed out after 120 polls");
}
