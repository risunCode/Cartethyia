// Kiro (CodeWhisperer) quota.
//
// Billing lives on two hosts and the right one depends on how the account
// authenticates: an API key or enterprise token is served by the Amazon
// surfaces, while the interactive families are answered by either. The
// endpoints are tried in order and the first usable answer wins.
//
// The account's region and profile matter here for the same reason they matter
// at dispatch: the request is scoped to them, and an account-bound credential
// must not be sent the shared placeholder profile.
//
// The usage surface is one of the places the upstream correlates a credential
// against the device it belongs to, so it presents the same frozen machine id
// and the same connection discipline as dispatch. A credential that reports one
// device here and another at dispatch is the shape this gateway exists to avoid.

import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  record,
  text,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import {
  buildKiroAmzUserAgent,
  buildKiroRuntimeUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { machineIdForAuthState } from "./kiro-machine-id";
import { resolveKiroProfileArn } from "./kiro-profile";

/** AWS region shape, checked before a region is interpolated into a URL. */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

interface KiroQuotaAuth {
  readonly region: string;
  readonly authMethod: string;
  readonly profileArn: string;
  readonly machineId: string;
}

/** Reads the account's auth configuration for the quota call. */
function quotaAuth(context: QuotaCollectionContext | undefined): KiroQuotaAuth {
  const raw = context?.auth_state ?? {};
  const regionRaw = typeof raw["region"] === "string" ? raw["region"].trim() : "";
  const region = AWS_REGION_PATTERN.test(regionRaw) ? regionRaw : "us-east-1";
  const authMethod = typeof raw["authMethod"] === "string" ? raw["authMethod"] : "builder-id";
  // The usage surface is profile-scoped and refuses a request without the field,
  // exactly as generation does, so it scopes to the same value generation does:
  // the account's own resolved profile, or nothing.
  const profileArn = resolveKiroProfileArn(raw);
  // The quota call reaches the same upstream as dispatch, so it presents the
  // same device identity through the same resolver. Deriving it independently
  // here is how one account ends up reporting two devices.
  const machineId = machineIdForAuthState(raw);
  return { region, authMethod, profileArn, machineId };
}

/** Headers every usage attempt shares. */
function usageHeaders(credential: string, auth: KiroQuotaAuth): Record<string, string> {
  const version = getKiroVersion();
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    accept: "application/json",
    connection: "close",
    "amz-sdk-request": "attempt=1; max=1",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amzn-codewhisperer-optout": "true",
    "x-amz-user-agent": buildKiroAmzUserAgent(version, auth.machineId),
    "user-agent": buildKiroRuntimeUserAgent(version, auth.machineId),
  };
  if (auth.authMethod === "api_key") headers["tokentype"] = "API_KEY";
  else if (auth.authMethod === "external_idp") headers["tokentype"] = "EXTERNAL_IDP";
  return headers;
}

/** One usage breakdown entry → a quota window. */
function breakdownWindow(breakdown: Record<string, unknown>, reset: string | null): ProviderQuotaWindow | null {
  const used = number(breakdown["currentUsageWithPrecision"]) ?? number(breakdown["currentUsage"]);
  const limit = number(breakdown["usageLimitWithPrecision"]) ?? number(breakdown["usageLimit"]);
  if (used === null || limit === null || limit <= 0) return null;
  const kind = text(breakdown["resourceType"])?.toLowerCase() ?? "unknown";
  return percentWindow(kind, kind, (used / limit) * 100, reset, used, limit);
}

/** The free-trial entry beside a breakdown, when the account has one. */
function freeTrialWindow(breakdown: Record<string, unknown>, reset: string | null): ProviderQuotaWindow | null {
  const trial = record(breakdown["freeTrialInfo"]);
  if (trial === null) return null;
  const used = number(trial["currentUsageWithPrecision"]) ?? number(trial["currentUsage"]);
  const limit = number(trial["usageLimitWithPrecision"]) ?? number(trial["usageLimit"]);
  if (used === null || limit === null || limit <= 0) return null;
  const kind = text(breakdown["resourceType"])?.toLowerCase() ?? "unknown";
  return percentWindow(
    `${kind}_freetrial`,
    `${kind} (free trial)`,
    (used / limit) * 100,
    isoDate(trial["freeTrialExpiry"]) ?? reset,
    used,
    limit,
  );
}

/** Parses the usage payload into windows. */
function parseUsage(payload: unknown): ProviderQuotaResult {
  const root = quotaRecord(payload);
  const reset = isoDate(root["nextDateReset"]) ?? isoDate(root["resetDate"]);
  const list = root["usageBreakdownList"];
  const windows: ProviderQuotaWindow[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const breakdown = record(entry);
      if (breakdown === null) continue;
      const window = breakdownWindow(breakdown, reset);
      if (window !== null) windows.push(window);
      const trial = freeTrialWindow(breakdown, reset);
      if (trial !== null) windows.push(trial);
    }
  }
  const subscription = record(root["subscriptionInfo"]);
  return {
    source: "kiro",
    plan: text(subscription?.["subscriptionTitle"]) ?? "Kiro",
    windows,
    error: null,
  };
}

/**
 * Reads Kiro's usage limits.
 *
 * Three surfaces are attempted in turn because which one answers depends on the
 * account's auth family and region; an auth refusal is remembered so the
 * reported error names the real cause instead of the last transport failure.
 */
export async function fetchKiroQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  if (token.length === 0) throw new Error("Kiro credential is empty.");
  const auth = quotaAuth(context);
  const headers = usageHeaders(token, auth);
  const query = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });
  const usageBody = JSON.stringify({
    origin: "AI_EDITOR",
    ...(auth.profileArn.length > 0 ? { profileArn: auth.profileArn } : {}),
    resourceType: "AGENTIC_REQUEST",
  });

  // Which surface answers depends on the account's auth family. The profile
  // travels in the POST body only: the GET form rejects it in the query with
  // `400`, which is what a freshly imported account was failing its test on.
  const attempts: readonly { readonly name: string; readonly run: () => Promise<Response> }[] = [
    {
      name: "codewhisperer-get",
      run: () =>
        fetcher(`https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?${query.toString()}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        }),
    },
    {
      name: "codewhisperer-post",
      run: () =>
        fetcher("https://codewhisperer.us-east-1.amazonaws.com", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/x-amz-json-1.0",
            "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          },
          body: usageBody,
          signal: AbortSignal.timeout(15_000),
        }),
    },
    {
      name: "q-get",
      run: () =>
        fetcher(`https://q.${auth.region}.amazonaws.com/getUsageLimits?${query.toString()}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        }),
    },
  ];

  let sawAuthRefusal = false;
  let lastError = "Unable to fetch Kiro usage right now.";
  for (const attempt of attempts) {
    let response: Response;
    try {
      response = await attempt.run();
    } catch (error) {
      lastError = `${attempt.name}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    if (!response.ok) {
      await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) sawAuthRefusal = true;
      lastError = `${attempt.name}: HTTP ${response.status}`;
      continue;
    }
    const payload = await response.json().catch(() => undefined);
    if (payload === undefined) {
      lastError = `${attempt.name}: response was not JSON`;
      continue;
    }
    return parseUsage(payload);
  }

  // A refused credential is the actionable answer, and it is the same whichever
  // surface refused it — say that rather than the last transport error.
  if (sawAuthRefusal) {
    return {
      source: "kiro",
      plan: null,
      windows: [],
      error: "Kiro rejected the stored credential for usage. Reconnect the account if this persists.",
    };
  }
  return { source: "kiro", plan: null, windows: [], error: lastError };
}
