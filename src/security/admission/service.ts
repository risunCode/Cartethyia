import { GatewayError } from "../../transport/gateway-error";
import { metrics } from "../../observability/metrics";
import { getAdmissionIdentity, modelRejectionReason } from "../api-key-auth";
import type {
  AdmissionCounterStore,
  AdmissionLease,
  AdmissionRejectionReason,
  ApiKeyAdmissionRequest,
} from "./contracts";
import { usageTokens } from "./buckets";
import { admissionMetricLabel, reasonToGatewayError } from "./reasons";

/** Persists reconciled lifetime token consumption for an API key. Injected so
 *  the in-memory admission service stays decoupled from Drizzle/Postgres. */
export type LifetimeUsagePersister = (input: {
  apiKeyId: string;
  delta: number;
}) => Promise<void>;

/** Performs one atomic pre-dispatch admission and returns an idempotent attempt lease. */
/** Reads the family's persisted `lifetime_tokens_consumed` fresh from the
 * durable store — the row plus every child, sum included. Called lazily by the
 * counter store only when it is about to seed a missing lifetime counter, so
 * the ≤3s-stale snapshot value cannot freeze a low baseline in place. Injected
 * so the admission module stays decoupled from Drizzle/Postgres. */
export type FreshLifetimeConsumedReader = (apiKeyId: string) => Promise<number | undefined>;


export class ApiKeyAdmissionService {
  constructor(
    private readonly store: AdmissionCounterStore,
    private readonly clock: () => number = () => Date.now(),
    private readonly tenantConcurrencyProvider: (
      tenantId: string,
    ) => Promise<number | null> | number | null = () => null,
    private readonly persistLifetimeUsage?: LifetimeUsagePersister,
    private readonly freshLifetimeConsumed?: FreshLifetimeConsumedReader,
  ) {
    if (!store) throw new Error("ApiKeyAdmissionService requires an admission store");
  }

  /**
   * Drops all admission state for one key (revocation). Best-effort: a
   * recycled key id must never inherit RPM/token/concurrency history.
   */
  async purgeKey(apiKeyId: string): Promise<void> {
    await this.store.purge(apiKeyId).catch(() => undefined);
  }

  /**
   * Seeds the current daily/monthly buckets from already-recorded spend so a
   * newly added limit is enforced against the whole bucket, not just from the
   * moment it was set. No-op when the store does not implement it.
   */
  async seedBuckets(request: {
    readonly apiKeyId: string;
    readonly now?: number;
    readonly daily?: number;
    readonly monthly?: number;
  }): Promise<void> {
    await this.store
      .seedBuckets?.({ ...request, now: request.now ?? this.clock() })
      .catch(() => undefined);
  }

  async admit(input: ApiKeyAdmissionRequest): Promise<AdmissionLease> {
    const reject = (reason: AdmissionRejectionReason, detail: Record<string, unknown>): never => {
      metrics.proxy_admission_total.inc(1, { reason: admissionMetricLabel(reason) });
      throw reasonToGatewayError(reason, detail);
    };

    if (input.signal?.aborted) reject("admission-unavailable", { reason: "aborted" });

    const snapshot = input.authorization;
    if (!snapshot) reject("admission-unavailable", { reason: "missing_snapshot" });

    const apiKeyId = getAdmissionIdentity(snapshot);
    if (!apiKeyId || !snapshot.tenant_id) {
      reject("admission-unavailable", { reason: "missing_snapshot" });
    }
    const rejected = modelRejectionReason(
      snapshot,
      input.targetModel,
      input.targetProvider,
      input.requestedModel,
    );
    if (rejected) {
      reject(rejected, { model: input.targetModel });
    }

    const estimatedTokens = Math.max(
      0,
      Math.floor((input.estimatedInputTokens ?? 0) + (input.estimatedOutputTokens ?? 0)),
    );
    const now = this.clock();
    const reservationId = `${apiKeyId}:${now}:${crypto.randomUUID()}`;
    const rawTenantLimit = this.tenantConcurrencyProvider(snapshot.tenant_id);
    const tenantLimit = rawTenantLimit instanceof Promise ? await rawTenantLimit : rawTenantLimit;

    try {
      await this.store.reserve({
        reservationId,
        apiKeyId,
        now,
        estimatedTokens,
        rpmLimit: snapshot.rpm ?? null,
        dailyLimit: snapshot.daily_tokens ?? null,
        monthlyLimit: snapshot.monthly_tokens ?? null,
        lifetimeBudget: snapshot.lifetime_token_budget ?? null,
        lifetimeConsumed: snapshot.lifetime_tokens_consumed ?? 0,
        concurrencyLimit: snapshot.max_concurrent ?? null,
        tenantId: snapshot.tenant_id,
        tenantConcurrencyLimit: tenantLimit,
        // Fresh lifetime reader is invoked by the store only when the counter
        // is missing; the hot path reads Redis alone.
        ...(this.freshLifetimeConsumed
          ? { freshLifetimeConsumed: () => this.freshLifetimeConsumed!(apiKeyId) }
          : {}),
      });
    } catch (error) {
      if (error instanceof GatewayError) {
        metrics.proxy_admission_total.inc(1, { reason: admissionMetricLabel(String(error.details.reason)) });
        throw error;
      }
      metrics.proxy_admission_total.inc(1, { reason: "admission_unavailable" });
      throw reasonToGatewayError("admission-unavailable", {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }

    metrics.proxy_admission_total.inc(1, { reason: "ok" });

    let finalized = false;
    return {
      reservationId,
      apiKeyId,
      get released() {
        return finalized;
      },
      commitUsage: async (usage) => {
        if (finalized) return;
        const actual = usageTokens(usage);
        await this.store.reconcile(apiKeyId, estimatedTokens, actual, reservationId);
        finalized = true;
        // Persist against the authenticating key (`snapshot.api_key_id`), not
        // the admission identity. Share children share the parent's counter
        // namespace for enforcement, but attribution must still land on the
        // child row so recipient usage and sumChildrenConsumed stay correct.
        if (this.persistLifetimeUsage) {
          try {
            await this.persistLifetimeUsage({ apiKeyId: snapshot.api_key_id, delta: actual });
          } catch {
            // Non-fatal: the transient counter already reflects reality; a
            // subsequent request will overwrite the row with the fresh count.
          }
        }
      },
      release: async () => {
        if (finalized) return;
        await this.store.release(apiKeyId, estimatedTokens, reservationId);
        finalized = true;
      },
    };
  }
}
