import {
  isDevicePollPending,
  parseDeviceAuthStart,
  readJsonResponse,
  record,
} from "./oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "./oauth-flow-store";
import { OAuthClient } from "./oauth-client";

/** Configuration for standard device-code start and poll requests. */
export interface DeviceFlowConfig {
  readonly tokenUrl: string;
  readonly deviceAuthUrl: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly formHeaders?: Record<string, string>;
  /** Body parameters for the device-authorization start request. */
  readonly startParams?: Record<string, string>;
}

/** Base OAuth client for providers that expose an RFC 8628 device flow. */
export abstract class OAuthDeviceFlow extends OAuthClient {
  async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    throw new Error(`${this.providerLabel} does not support device authorization`);
  }

  async pollDeviceAuth(
    _deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    return { status: "failed", reason: `${this.providerLabel} does not support device authorization` };
  }

  /** Standard device-authorization start. Override the body builder for custom providers. */
  protected async startGenericDeviceAuth(config: DeviceFlowConfig): Promise<OAuthDeviceStartResult> {
    const body = this.buildDeviceStartBody(config);
    const response = await this.fetchFn(config.deviceAuthUrl, {
      method: "POST",
      ...(config.formHeaders === undefined ? {} : { headers: config.formHeaders }),
      body,
    });
    const payload = await readJsonResponse(response, `${this.providerLabel} device authorization`);
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    if (!start) {
      throw new Error(`${this.providerLabel} device authorization returned an invalid response`);
    }
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
    };
  }

  protected buildDeviceStartBody(config: DeviceFlowConfig): URLSearchParams {
    const params: Record<string, string> = { client_id: config.clientId };
    if (config.scope) params.scope = config.scope;
    if (config.startParams) Object.assign(params, config.startParams);
    return new URLSearchParams(params);
  }

  /** Standard device-token poll. Returns pending while authorization is incomplete. */
  protected async pollGenericDeviceAuth(
    deviceAuthId: string,
    config: DeviceFlowConfig,
  ): Promise<OAuthDevicePollResult> {
    const response = await this.fetchFn(config.tokenUrl, {
      method: "POST",
      ...(config.formHeaders === undefined ? {} : { headers: config.formHeaders }),
      body: new URLSearchParams({
        client_id: config.clientId,
        device_code: deviceAuthId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
    const root = record(payload) ?? {};
    if (response.status === 400 || response.status === 428) {
      const err = typeof root.error === "string" ? root.error : "";
      if (isDevicePollPending(err)) return { status: "pending" };
      return { status: "failed", reason: err || `device polling failed (${response.status})` };
    }
    if (!response.ok || payload === undefined) {
      return { status: "failed", reason: `device polling failed (${response.status})` };
    }
    if (typeof root.access_token !== "string" || !root.access_token) {
      return { status: "failed", reason: `${this.providerLabel} token response omitted access_token` };
    }
    const normalized = this.parseTokenResponse(payload);
    return { status: "complete", result: this.toExchangeResult(normalized) };
  }
}
