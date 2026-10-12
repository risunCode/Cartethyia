/**
 * Alibaba Token Plan (Coding Plan) login.
 *
 * Not an OAuth grant: the plan issues a durable `sk-sp-…` key, and the two
 * plans — international and mainland China — are served by different hosts
 * whose keys are not interchangeable. Dispatching a key to the wrong host fails
 * with an upstream auth error that names neither plan, so the region travels
 * with the token in one stored envelope rather than being inferred.
 *
 * The console renders a form from `importFields` and persists whatever
 * `importCredential` returns, so declaring the region is what keeps the choice
 * explicit rather than a guess made at dispatch time.
 *
 * No refresh grant exists, so the stored value is used exactly as issued.
 */
import type {
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginClient,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import { readJsonResponse } from "../../authentication/oauth-flow-store";
import type { FetchLike } from "../../authentication/oauth-client";
import {
  encodeAlibabaCodingPlanCredential,
  type AlibabaCodingPlanEnvelope,
} from "../../../security/credential-codec";

/**
 * The two plan regions and the host each is served from.
 *
 * A value not in this map is rejected at login rather than at dispatch: an
 * unknown region would otherwise become a base URL built from nothing.
 */
export const ALIBABA_CODING_PLAN_REGIONS = {
  international: {
    label: "International (Singapore)",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  },
  china: {
    label: "China (Beijing)",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
} as const satisfies Readonly<
  Record<string, { readonly label: string; readonly baseUrl: string }>
>;

export type AlibabaCodingPlanRegion = keyof typeof ALIBABA_CODING_PLAN_REGIONS;

/** The base URL a stored region resolves to, or `undefined` when unknown. */
export function alibabaCodingPlanBaseUrl(region: string): string | undefined {
  const entry =
    ALIBABA_CODING_PLAN_REGIONS[region as AlibabaCodingPlanRegion];
  return entry?.baseUrl;
}

export const ALIBABA_CODING_PLAN_IMPORT_FIELDS: readonly OAuthLoginField[] = [
  {
    key: "region",
    label: "Plan region",
    required: true,
    defaultValue: "international",
    options: Object.entries(ALIBABA_CODING_PLAN_REGIONS).map(([value, entry]) => ({
      value,
      label: entry.label,
    })),
  },
];

async function validateToken(
  envelope: AlibabaCodingPlanEnvelope,
  fetchFn: FetchLike,
): Promise<void> {
  const baseUrl = alibabaCodingPlanBaseUrl(envelope.region);
  if (baseUrl === undefined) {
    throw new Error(`Unknown Alibaba Token Plan region "${envelope.region}"`);
  }
  // `/models` on the chosen region's host proves both the token and that the
  // region matches the key, and costs no tokens. Validating against the other
  // region would report a working key as broken.
  const response = await fetchFn(`${baseUrl}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${envelope.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Alibaba rejected the token for the ${envelope.region} plan; the two plans' keys are not interchangeable`,
    );
  }
  await readJsonResponse(response, "Alibaba Token Plan model list");
}

/** Alibaba Coding Plan login: a durable plan key bound to one region. */
export class AlibabaCodingPlanOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = false;
  readonly importFields = ALIBABA_CODING_PLAN_IMPORT_FIELDS;

  constructor(private readonly fetchFn: FetchLike = globalThis.fetch) {}

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const envelope: AlibabaCodingPlanEnvelope = {
      token: input.credential.trim(),
      region: (input.fields["region"] ?? "international").trim(),
    };
    if (!envelope.token) throw new Error("Paste an Alibaba Token Plan key");
    if (alibabaCodingPlanBaseUrl(envelope.region) === undefined) {
      throw new Error(`Unknown Alibaba Token Plan region "${envelope.region}"`);
    }
    await validateToken(envelope, this.fetchFn);
    const access = encodeAlibabaCodingPlanCredential(envelope);
    return {
      access,
      // No refresh grant. Mirrored because `refresh_ciphertext` is NOT NULL and
      // the value is never presented to a token endpoint.
      refresh: access,
      // The plan publishes no token expiry, so a far-future value keeps the
      // freshness check from scheduling a refresh nothing can perform.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      ...(input.accountLabel === undefined || input.accountLabel.trim() === ""
        ? {}
        : { accountLabel: input.accountLabel.trim() }),
    };
  }
}

export const alibabaCodingPlanOAuthClient = new AlibabaCodingPlanOAuthClient();