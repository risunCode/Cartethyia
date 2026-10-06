import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";
import {
  nonEmptyTrimmedString,
  record,
  type OAuthAuthorizeRequest,
  type OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { GatewayError } from "../../../protocol/gateway-error";
import { oauthCallbackUrl } from "../../../config/providers";
import { acquireMimoServiceSession, invalidateMimoSessionCache } from "./mimodesktop-sso";

export const MIMO_DESKTOP_CLIENT_ID = "mimocode-desktop" as const;

export interface ExtractedMimoCredentials {
  readonly passToken: string;
  readonly userId?: string | undefined;
  readonly cUserId?: string | undefined;
}

/** Default path for Xiaomi MiMo AI Desktop Electron cookie database on Windows/macOS/Linux. */
export function getDesktopCookieDbPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      home,
      "AppData",
      "Roaming",
      "Xiaomi MiMo AI",
      "Partitions",
      "xiaomi-account",
      "Network",
      "Cookies",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Xiaomi MiMo AI",
      "Partitions",
      "xiaomi-account",
      "Network",
      "Cookies",
    );
  }
  return path.join(
    home,
    ".config",
    "Xiaomi MiMo AI",
    "Partitions",
    "xiaomi-account",
    "Network",
    "Cookies",
  );
}

/**
 * Reads passToken and identity cookies directly from Xiaomi MiMo Desktop profile.
 */
export async function readDesktopPassToken(): Promise<ExtractedMimoCredentials | null> {
  const src = getDesktopCookieDbPath();
  if (!existsSync(src)) return null;

  const tmp = path.join(
    os.tmpdir(),
    `mimo-cookies-${process.pid}-${Date.now()}.db`,
  );
  try {
    const fs = await import("node:fs");
    fs.copyFileSync(src, tmp);
  } catch {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Xiaomi MiMo AI Desktop is running and holding its session database locked. Quit MiMo Desktop completely, then retry.",
    );
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    const query = "SELECT name, value FROM cookies WHERE host_key LIKE '%account.xiaomi.com'";
    const rows = db.prepare(query).all() as Array<{ name: unknown; value: unknown }>;
    db.close();

    const jar: Record<string, string> = {};
    for (const r of rows) {
      if (typeof r.name === "string" && typeof r.value === "string") {
        jar[r.name] = r.value;
      }
    }

    const passToken = jar["passToken"];
    if (!passToken || passToken.trim().length === 0) return null;

    const res: ExtractedMimoCredentials = {
      passToken: passToken.trim(),
      ...(jar["userId"] ? { userId: jar["userId"].trim() } : {}),
      ...(jar["cUserId"] ? { cUserId: jar["cUserId"].trim() } : {}),
    };
    return res;
  } finally {
    try {
      const fs = await import("node:fs");
      fs.unlinkSync(tmp);
    } catch {
      // Ignore cleanup
    }
  }
}

/**
 * Parses either a raw passToken string or a JSON object containing passToken and userId.
 */
export function parseMimoCredential(raw: string): ExtractedMimoCredentials {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new GatewayError("invalid_request", 400, "MiMo Desktop credential cannot be empty");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const obj = record(parsed);
    if (obj) {
      const nestedXiaomi = record(obj["xiaomi"]);
      const target = nestedXiaomi ?? obj;
      const passToken =
        nonEmptyTrimmedString(target["passToken"]) ??
        nonEmptyTrimmedString(target["passtoken"]) ??
        nonEmptyTrimmedString(target["pass_token"]) ??
        nonEmptyTrimmedString(target["refresh_token"]) ??
        nonEmptyTrimmedString(target["key"]) ??
        nonEmptyTrimmedString(target["token"]);
      const userId =
        nonEmptyTrimmedString(target["userId"]) ??
        nonEmptyTrimmedString(target["userid"]) ??
        nonEmptyTrimmedString(target["uid"]);
      const cUserId =
        nonEmptyTrimmedString(target["cUserId"]) ??
        nonEmptyTrimmedString(target["cuserid"]);

      if (passToken) {
        return {
          passToken,
          ...(userId ? { userId } : {}),
          ...(cUserId ? { cUserId } : {}),
        };
      }
    }
  } catch {
    // Treat raw string as passToken
  }

  return { passToken: trimmed };
}

export function encodeMimoCredential(creds: ExtractedMimoCredentials): string {
  return JSON.stringify(creds);
}

export class MimoDesktopOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "MiMo Desktop";
  protected override readonly clientId = MIMO_DESKTOP_CLIENT_ID;
  protected override readonly tokenUrl = "https://mimo-server-sgp.xiaomimimo.com";
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const targetUrl = new URL(oauthCallbackUrl("mimodesktop"));
    targetUrl.searchParams.set("state", request.state);
    targetUrl.searchParams.set("code", "local-desktop-import");
    return targetUrl.toString();
  }

  override async exchangeCode(
    _code: string,
    _codeVerifier: string,
    _redirectUri: string,
    _state?: string,
  ): Promise<OAuthExchangeResult> {
    const creds = await readDesktopPassToken();
    if (!creds) {
      throw new GatewayError(
        "authentication_failed",
        401,
        "Xiaomi MiMo Desktop session not found. Please log in to Xiaomi MiMo Desktop first, or paste your passToken via 'Add Account'.",
      );
    }

    // Warm up the SSO session immediately to verify credentials
    await acquireMimoServiceSession(
      { passToken: creds.passToken, ...(creds.userId ? { userId: creds.userId } : {}) },
      this.fetchFn as typeof fetch,
    );

    const label = creds.userId ? `Xiaomi MiMo (${creds.userId})` : "Xiaomi MiMo Desktop";

    return {
      access: encodeMimoCredential(creds),
      refresh: creds.passToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // passToken is durable
      accountLabel: label,
    };
  }

  override async refresh(refreshToken: string, _signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const creds = parseMimoCredential(refreshToken);
    invalidateMimoSessionCache();
    await acquireMimoServiceSession(
      { passToken: creds.passToken, ...(creds.userId ? { userId: creds.userId } : {}) },
      this.fetchFn as typeof fetch,
    );

    return {
      access: encodeMimoCredential(creds),
      refresh: creds.passToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }
}

export const mimoDesktopOAuthClient = new MimoDesktopOAuthClient();
