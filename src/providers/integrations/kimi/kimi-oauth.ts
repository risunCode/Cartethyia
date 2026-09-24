/**
 * Kimi Code (Moonshot) device-code OAuth flow.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import { isRecord } from "../../../protocol/primitives";
import { expiryFromSeconds, isDevicePollPending, parseDeviceAuthStart, readJsonResponse } from "../../authentication/oauth-flow-store";
import type { OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { getKimiCliVersion, refreshKimiCliVersion } from "../../operations/client-versions";
import { resolveKimiOAuthHost } from "../../../config";

const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_CODE_OAUTH_HOST = resolveKimiOAuthHost();
const KIMI_CODE_DEVICE_AUTHORIZE_URL = `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`;
const KIMI_CODE_TOKEN_URL = `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`;

const DEVICE_ID_BYTES = 16;

/** Persisted access secret shape for a Kimi OAuth account. */
interface KimiOAuthCredential {
  readonly accessToken: string;
  readonly deviceId: string;
}

interface KimiRefreshCredential {
  readonly refreshToken: string;
  readonly deviceId: string;
}

function encodeKimiCredential(accessToken: string, deviceId: string): string {
  return JSON.stringify({ accessToken, deviceId });
}

export function parseKimiCredential(value: string): KimiOAuthCredential {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Kimi credential is empty");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
      const deviceId = typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : "";
      if (accessToken && deviceId) return { accessToken, deviceId };
    }
  } catch {
    // Legacy installations may hold a raw access token; fall through.
  }
  return { accessToken: trimmed, deviceId: deviceIdForScope(trimmed) };
}

function encodeRefreshCredential(refreshToken: string, deviceId: string): string {
  return JSON.stringify({ refreshToken, deviceId });
}

function parseRefreshCredential(value: string): KimiRefreshCredential {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Kimi refresh credential is empty");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "";
      const deviceId = typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : "";
      if (refreshToken && deviceId) return { refreshToken, deviceId };
    }
  } catch {
    // Legacy installations may hold a raw refresh token; derive a stable id.
  }
  return { refreshToken: trimmed, deviceId: deviceIdForScope(trimmed) };
}

function deviceModel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const label =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return [label, release, arch].filter(Boolean).join(" ").trim();
}

function sanitizeHeaderValue(value: string, fallback = "unknown"): string {
  const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
  return sanitized || fallback;
}

function createKimiDeviceId(): string {
  return crypto.randomBytes(DEVICE_ID_BYTES).toString("hex");
}

function deviceIdForScope(scope: string): string {
  return crypto.createHash("sha256").update(`cartethyia:kimi:${scope}`).digest("hex").slice(0, 32);
}

export function getKimiCommonHeaders(deviceId = deviceIdForScope("process-default")): Readonly<Record<string, string>> {
  refreshKimiCliVersion();
  const version = getKimiCliVersion();
  return Object.freeze({
    "user-agent": `KimiCLI/${version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": version,
    "X-Msh-Device-Name": sanitizeHeaderValue(os.hostname()),
    "X-Msh-Device-Model": sanitizeHeaderValue(deviceModel()),
    "X-Msh-Os-Version": sanitizeHeaderValue(os.version()),
    "X-Msh-Device-Id": sanitizeHeaderValue(deviceId),
  });
}

function jsonHeaders(deviceId?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...getKimiCommonHeaders(deviceId),
  };
}

interface DeviceTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  user_id?: unknown;
  sub?: unknown;
}

export class KimiCodeOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Kimi Code";
  protected override readonly clientId = KIMI_CODE_CLIENT_ID;
  protected override readonly tokenUrl = KIMI_CODE_TOKEN_URL;
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult & { providerState: string }> {
    const deviceId = createKimiDeviceId();
    // The Kimi device-authorization endpoint only parses
    // `application/x-www-form-urlencoded` bodies — JSON `client_id` is
    // rejected with `client_id is required`.
    const body = new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID });
    const response = await this.fetchFn(KIMI_CODE_DEVICE_AUTHORIZE_URL, {
      method: "POST",
      headers: { ...jsonHeaders(deviceId), "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await readJsonResponse(response, "Kimi Code device authorization");
    const start = parseDeviceAuthStart(payload, { intervalSeconds: 5, expiresInSeconds: 900 });
    if (!start) throw new Error("Kimi Code device authorization returned an invalid response");
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
      providerState: deviceId,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const deviceId = context?.providerState || deviceIdForScope(deviceAuthId);
    // Same form-encoding requirement as the authorize call above.
    const body = new URLSearchParams({
      client_id: KIMI_CODE_CLIENT_ID,
      device_code: deviceAuthId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const response = await this.fetchFn(KIMI_CODE_TOKEN_URL, {
      method: "POST",
      headers: { ...jsonHeaders(deviceId), "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    let payload: DeviceTokenResponse | undefined;
    try {
      payload = JSON.parse(text) as DeviceTokenResponse;
    } catch {
      payload = undefined;
    }
    if (response.status === 400 || response.status === 428) {
      const err = payload && typeof payload.error === "string" ? payload.error : "";
      if (isDevicePollPending(err)) return { status: "pending" };
      return { status: "failed", reason: err || `device polling failed (${response.status})` };
    }
    if (!response.ok || !payload) {
      return { status: "failed", reason: `device polling failed (${response.status})` };
    }
    const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    if (!accessToken) return { status: "pending" };
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
    if (!refreshToken) {
      return { status: "failed", reason: "Kimi Code token response omitted refresh_token" };
    }
    const accountId =
      (typeof payload.user_id === "string" && payload.user_id.trim()) ||
      (typeof payload.sub === "string" && payload.sub.trim()) ||
      undefined;
    return {
      status: "complete",
      result: {
        access: encodeKimiCredential(accessToken, deviceId),
        refresh: encodeRefreshCredential(refreshToken, deviceId),
        expiresAt: expiryFromSeconds(payload.expires_in, 86_400),
        ...(accountId ? { accountLabel: accountId } : {}),
      },
    };
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const parsedRefresh = parseRefreshCredential(refreshToken);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body = new URLSearchParams({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: parsedRefresh.refreshToken,
      });
      const response = await this.fetchFn(KIMI_CODE_TOKEN_URL, {
        method: "POST",
        headers: { ...jsonHeaders(parsedRefresh.deviceId), "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      const payload = (await readJsonResponse(response, "Kimi Code token refresh")) as DeviceTokenResponse;
      const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
      if (!access) throw new Error("Kimi Code refresh omitted access_token");
      const nextRefresh =
        typeof payload.refresh_token === "string" && payload.refresh_token.trim()
          ? payload.refresh_token.trim()
          : parsedRefresh.refreshToken;
      return {
        access: encodeKimiCredential(access, parsedRefresh.deviceId),
        refresh: encodeRefreshCredential(nextRefresh, parsedRefresh.deviceId),
        expiresAt: expiryFromSeconds(payload.expires_in, 86_400),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const kimiCodeOAuthClient = new KimiCodeOAuthClient();
