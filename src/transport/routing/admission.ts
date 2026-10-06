// Routing inflight admission controllers (in-memory and Redis-backed).
import { metrics } from "../../observability/metrics";
import { resolveInflightTtlSeconds } from "../../config/timeouts";
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import type {
  AdmissionController,
  AdmissionDecision,
  Reservation,
  RouteCandidate,
} from "./route-model";

/**
 * Admission bucket identity. Account-scoped so each account of a provider
 * enforces its own concurrency ceiling; candidates without an account id
 * (credential-less providers) fall back to the provider:model bucket.
 */
function admissionKey(candidate: RouteCandidate): string {
  const base = `${candidate.provider_id}:${candidate.model_id}`;
  return candidate.provider_account_id === undefined
    ? base
    : `${base}:${candidate.provider_account_id}`;
}

/**
 * What one candidate's configured ceiling tells admission to do, before any
 * back end has looked at its counter.
 */
type AdmissionDirective =
  | { readonly kind: "unlimited" }
  | { readonly kind: "reject" }
  | { readonly kind: "bounded"; readonly limit: number };

/**
 * The one admission policy, shared by both controllers.
 *
 * Both back ends must reach the same three-way decision for one candidate:
 * no configured ceiling (account and routing panel both empty) means the
 * account is UNLIMITED — still counted, so inflight stays observable, but
 * never rejected; a non-positive ceiling is a configured zero, so every
 * request is rejected; and reaching the ceiling rejects. Only the comparison
 * itself is back-end specific (a `Map` read here, an atomic Lua `GET`/`INCR`
 * for Redis), so the decision and the rejection it produces live in one
 * place and the two deployments cannot report different telemetry for the
 * same input.
 */
function admissionDirective(candidate: RouteCandidate): AdmissionDirective {
  const limit = candidate.max_inflight;
  if (limit === undefined) return { kind: "unlimited" };
  if (limit <= 0) return { kind: "reject" };
  return { kind: "bounded", limit };
}

/** The one shape of an admission rejection: the metric, then the decision. */
function capacityRejected(): AdmissionDecision {
  metrics.proxy_admission_total.inc(1, { reason: "provider_capacity" });
  return { admitted: false, reason: "capacity_exhausted" };
}

export class InMemoryAdmissionController implements AdmissionController {
  private inflight = new Map<string, number>();
  snapshotAccountInflight(): ReadonlyMap<string, number> {
    return new Map(this.inflight);
  }
  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    // Bucket per ACCOUNT, not per provider:model. A provider with N accounts
    // holds N independent ceilings, so total inflight scales with the account
    // count instead of every account sharing one pool-wide bucket (which made
    // round-robin look "sticky": account 2+ was always admitted-rejected).
    const key = admissionKey(candidate);
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    const cur = this.inflight.get(key) ?? 0;
    if (directive.kind === "bounded" && cur >= directive.limit) return capacityRejected();
    this.inflight.set(key, cur + 1);
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    const key = admissionKey(reservation.candidate);
    const cur = this.inflight.get(key) ?? 1;
    // Delete at zero rather than storing it: keys are per account/model and
    // models churn, so retained zeroes would grow the map for the process
    // lifetime. Absent reads as zero everywhere this map is consulted.
    if (cur <= 1) this.inflight.delete(key);
    else this.inflight.set(key, cur - 1);
  }
}

/**
 * Redis-backed admission controller for routing inflight. Replaces the
 * in-memory controller so multi-instance deployments enforce one shared
 * per-account inflight bucket — mirroring the in-memory controller's
 * account-scoped ceiling. The TTL self-heals crash-orphaned increments without
 * the full lease machinery (over-inflating a route slot is bounded and less
 * harmful than corrupting quota counters).
 *
 * The TTL is the shared {@link resolveInflightTtlSeconds}, not a local
 * constant: it must exceed the longest legitimate slot hold, which is the
 * upstream deadline plus the stream stall budget. A fixed 60s expired a slot
 * mid-stream for any request running longer than a minute, so a second request
 * could admit against the freed slot and exceed the configured ceiling. The
 * pool selector holds its slot for the same request duration and derives the
 * same value, so both admit on one invariant.
 */
const INFLIGHT_TTL_SECONDS = resolveInflightTtlSeconds();

const ADMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return 0 end
local next = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return next
`;

/** Counts an admission without any ceiling (unlimited account). */
const UNLIMITED_ADMIT_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`;
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
local next = redis.call('DECR', KEYS[1])
if next <= 0 then redis.call('DEL', KEYS[1]) end
return next
`;

export class RedisAdmissionController implements AdmissionController {
  constructor(private readonly redis: RedisClient) {}

  private key(candidate: RouteCandidate): string {
    return `admission:inflight:${admissionKey(candidate)}`;
  }

  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    // The unlimited path counts with the TTL self-heal but never compares
    // against a ceiling, so no limit argument ever reaches the ceiling script.
    const result = await redisEvalNumber(
      this.redis,
      directive.kind === "unlimited" ? UNLIMITED_ADMIT_SCRIPT : ADMIT_SCRIPT,
      1,
      this.key(candidate),
      ...(directive.kind === "unlimited"
        ? [INFLIGHT_TTL_SECONDS]
        : [directive.limit, INFLIGHT_TTL_SECONDS]),
    );
    if (directive.kind === "bounded" && result === 0) return capacityRejected();
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    await redisEvalNumber(this.redis, RELEASE_SCRIPT, 1, this.key(reservation.candidate));
  }

  async snapshotAccountInflight(): Promise<ReadonlyMap<string, number>> {
    const keys = await this.redis.keys("admission:inflight:*");
    if (keys.length === 0) return new Map();
    const values = await this.redis.mget(...keys);
    const snapshot = new Map<string, number>();
    for (const [index, key] of keys.entries()) {
      const value = Number(values[index] ?? 0);
      if (Number.isFinite(value) && value > 0) {
        snapshot.set(key.slice("admission:inflight:".length), value);
      }
    }
    return snapshot;
  }
}
