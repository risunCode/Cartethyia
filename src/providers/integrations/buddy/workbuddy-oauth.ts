// WorkBuddy OAuth — browser-assisted state polling (non-PKCE) plus refresh.
// Canonical provider ID: workbuddy (international / WorkBuddy AI).
import { providerBaseUrl } from "../../provider-metadata";
import { buildWorkBuddyUserAgent, resolveWorkBuddyVersion } from "../../operations/client-versions";
import {
  BuddyOAuthClient,
  coercingResponseCode,
  type BuddyOAuthVariant,
} from "./buddy-oauth-shared";
import { WORKBUDDY_DOMAIN } from "./workbuddy-shared";

export const WORKBUDDY_DEVICE_START_URL = `${providerBaseUrl("workbuddy")}/v2/plugin/auth/state`;
export const WORKBUDDY_DEVICE_POLL_URL = `${providerBaseUrl("workbuddy")}/v2/plugin/auth/token`;
export const WORKBUDDY_REFRESH_URL = `${providerBaseUrl("workbuddy")}/v2/plugin/auth/token/refresh`;

/** The international WorkBuddy gateway: `CLI` platform, `WorkBuddy AI` identity. */
export const WORKBUDDY_OAUTH_VARIANT: BuddyOAuthVariant = {
  providerId: "workbuddy",
  providerLabel: "WorkBuddy",
  domain: WORKBUDDY_DOMAIN,
  platform: "CLI",
  userAgent: async () => {
    await resolveWorkBuddyVersion();
    return buildWorkBuddyUserAgent();
  },
  deviceStartUrl: WORKBUDDY_DEVICE_START_URL,
  devicePollUrl: WORKBUDDY_DEVICE_POLL_URL,
  refreshUrl: WORKBUDDY_REFRESH_URL,
  responseCode: coercingResponseCode,
};

export const workBuddyOAuthClient = new BuddyOAuthClient(WORKBUDDY_OAUTH_VARIANT);
