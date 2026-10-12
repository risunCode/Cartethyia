// WorkBuddy CN device login shares WorkBuddy's contract on its China domain.
import {
  buildWorkBuddyUserAgent,
  getWorkBuddyCnClientVersion,
  getWorkBuddyCliVersion,
} from "../../operations/client-versions";
import { providerBaseUrl } from "../../metadata";
import {
  BuddyOAuthClient,
  coercingResponseCode,
  type BuddyOAuthVariant,
} from "./buddy-oauth-shared";
import { WORKBUDDY_CN_DOMAIN } from "./workbuddy-cn";

const baseUrl = providerBaseUrl("workbuddycn");

export const WORKBUDDY_CN_OAUTH_VARIANT: BuddyOAuthVariant = {
  providerId: "workbuddycn",
  providerLabel: "WorkBuddy CN",
  domain: WORKBUDDY_CN_DOMAIN,
  platform: "CLI",
  userAgent: async () =>
    buildWorkBuddyUserAgent(getWorkBuddyCnClientVersion(), getWorkBuddyCliVersion()),
  deviceStartUrl: `${baseUrl}/v2/plugin/auth/state`,
  devicePollUrl: `${baseUrl}/v2/plugin/auth/token`,
  refreshUrl: `${baseUrl}/v2/plugin/auth/token/refresh`,
  responseCode: coercingResponseCode,
};

export const workBuddyCnOAuthClient = new BuddyOAuthClient(WORKBUDDY_CN_OAUTH_VARIANT);
