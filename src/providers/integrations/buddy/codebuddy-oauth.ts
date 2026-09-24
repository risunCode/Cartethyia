// CodeBuddy OAuth — browser-assisted state polling (non-PKCE) plus bespoke refresh.
// Canonical provider IDs: cb and cbcn.
import { providerBaseUrl } from "../../provider-metadata";
import { buildCodeBuddyUserAgent, resolveCodeBuddyVersion } from "../../operations/client-versions";
import {
  BuddyOAuthClient,
  strictResponseCode,
  type BuddyOAuthVariant,
} from "./buddy-oauth-shared";

const CODEBUDDY_INTL_DEVICE_START_URL = `${providerBaseUrl("cb")}/plugin/auth/state`;
const CODEBUDDY_INTL_DEVICE_POLL_URL = `${providerBaseUrl("cb")}/plugin/auth/token`;
const CODEBUDDY_INTL_REFRESH_URL = `${providerBaseUrl("cb")}/plugin/auth/token/refresh`;
const CODEBUDDY_CN_DEVICE_START_URL = `${providerBaseUrl("cbcn")}/plugin/auth/state`;
const CODEBUDDY_CN_DEVICE_POLL_URL = `${providerBaseUrl("cbcn")}/plugin/auth/token`;
const CODEBUDDY_CN_REFRESH_URL = `${providerBaseUrl("cbcn")}/plugin/auth/token/refresh`;

export const CODEBUDDY_INTL_VARIANT: BuddyOAuthVariant = {
  providerId: "cb",
  providerLabel: "CodeBuddy",
  domain: "www.codebuddy.ai",
  platform: "ide",
  userAgent: async () => {
    await resolveCodeBuddyVersion();
    return buildCodeBuddyUserAgent("IDE");
  },
  deviceStartUrl: CODEBUDDY_INTL_DEVICE_START_URL,
  devicePollUrl: CODEBUDDY_INTL_DEVICE_POLL_URL,
  refreshUrl: CODEBUDDY_INTL_REFRESH_URL,
  responseCode: strictResponseCode,
};

export const CODEBUDDY_CN_VARIANT: BuddyOAuthVariant = {
  providerId: "cbcn",
  providerLabel: "CodeBuddy",
  domain: "copilot.tencent.com",
  platform: "CLI",
  userAgent: async () => {
    await resolveCodeBuddyVersion();
    return buildCodeBuddyUserAgent("CLI");
  },
  deviceStartUrl: CODEBUDDY_CN_DEVICE_START_URL,
  devicePollUrl: CODEBUDDY_CN_DEVICE_POLL_URL,
  refreshUrl: CODEBUDDY_CN_REFRESH_URL,
  responseCode: strictResponseCode,
};

export const codeBuddyOAuthClient = new BuddyOAuthClient(CODEBUDDY_INTL_VARIANT);
export const codeBuddyCnOAuthClient = new BuddyOAuthClient(CODEBUDDY_CN_VARIANT);
