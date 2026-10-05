import type { AdmissionRejectionReason } from "./contracts";
import { reasonToGatewayError } from "./reasons";
import {
  CONCURRENCY_TTL_SECONDS,
  DAILY_COUNTER_TTL_SECONDS,
  LIFETIME_COUNTER_TTL_SECONDS,
  MONTHLY_COUNTER_TTL_SECONDS,
  RPM_WINDOW_TTL_SECONDS,
} from "./ttl";

/**
 * The three atomic scripts every Redis admission operation runs.
 *
 * They live apart from the store that calls them because they are the
 * enforcement itself: a limit check and its counter write must be one
 * indivisible step, which is why the logic is Lua rather than TypeScript.
 * Reading them next to each other is the only way to see that reserve,
 * reconcile, and release agree on the lease hash fields.
 */
/**
 * RESERVE — the atomic admission algorithm. Runs as one Redis Lua script so
 * every limit is validated and the reservation created in a single atomic
 * step: no read-modify-write race can let two requests through the last
 * remaining slot, and no partially applied reservation can survive (all
 * counter writes + the lease hash commit together or not at all).
 *
 * Idempotency: an existing lease hash in any state short-circuits to `1`
 * (already reserved) so a retried admission cannot double-charge counters.
 *
 * Limit model — rate limits vs concurrency:
 * - RPM (KEYS[1], a ZSET of timestamps): sliding 60s window, pruned with
 *   ZREMRANGEBYSCORE before counting. Admission is count-based, not
 *   token-based.
 * - Daily / monthly / lifetime token budgets (KEYS[2]/[3]/[5]): the
 *   *estimated* token count is pre-credited at reserve time and reconciled
 *   to actual usage later (RECONCILE_SCRIPT), so a request that would exceed
 *   its budget is rejected before dispatch, never after.
 * - Concurrency (KEYS[4], per API key) and tenant concurrency (KEYS[7]) are
 *   classic INCR/DECR slots held for the request duration; the lease hash
 *   (KEYS[6]) records which counters each reservation tracks so release
 *   reverses exactly those.
 *
 * Key naming: `admission:<kind>[:<apiKeyId>|<tenantId>][:<bucket>]` —
 * `admission:rpm:<key>`, `admission:daily:<key>:<YYYY-MM-DD>`,
 * `admission:monthly:<key>:<YYYY-MM>`, `admission:lifetime:<key>`,
 * `admission:concurrent:<key>`, `admission:tenant_concurrent:<tenant>`,
 * `admission:lease:<reservationId>`. All counters carry TTLs (roughly one
 * bucket + slack) so a process death cannot leak counters forever.
 *
 * Return codes: `0` reserved; `1` idempotent replay; `-1..-6` limit
 * rejections (mapped to GatewayErrors by `assertResult`); `-99` corrupt
 * counter state (never bypassed — admission fails closed).
 */
export const RESERVE_SCRIPT = `
local state = redis.call('HGET', KEYS[6], 'state')
if state == 'active' or state == 'committed' or state == 'released' then return 1 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - 60000)
local rpm = redis.call('ZCARD', KEYS[1])
local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
local monthly = tonumber(redis.call('GET', KEYS[3]) or '0')
local concurrent = tonumber(redis.call('GET', KEYS[4]) or '0')
local tenantConcurrent = tonumber(redis.call('GET', KEYS[7]) or '0')
local lifetime = 0
if tonumber(ARGV[6]) then
  local rawLifetime = redis.call('GET', KEYS[5])
  lifetime = rawLifetime and tonumber(rawLifetime) or tonumber(ARGV[9])
  if not lifetime then return -99 end
  if not rawLifetime then redis.call('SET', KEYS[5], lifetime, 'EX', ${LIFETIME_COUNTER_TTL_SECONDS}) end
end
local estimated = tonumber(ARGV[2])
if not estimated or estimated < 0 then return -99 end
if tonumber(ARGV[3]) and rpm >= tonumber(ARGV[3]) then return -1 end
if tonumber(ARGV[4]) and daily + estimated > tonumber(ARGV[4]) then return -2 end
if tonumber(ARGV[5]) and monthly + estimated > tonumber(ARGV[5]) then return -3 end
if tonumber(ARGV[6]) and lifetime + estimated > tonumber(ARGV[6]) then return -4 end
if tonumber(ARGV[7]) and concurrent >= tonumber(ARGV[7]) then return -5 end
if tonumber(ARGV[10]) and tenantConcurrent >= tonumber(ARGV[10]) then return -6 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[8])
redis.call('EXPIRE', KEYS[1], ${RPM_WINDOW_TTL_SECONDS})
if tonumber(ARGV[4]) then redis.call('INCRBY', KEYS[2], estimated); redis.call('EXPIRE', KEYS[2], ${DAILY_COUNTER_TTL_SECONDS}) end
if tonumber(ARGV[5]) then redis.call('INCRBY', KEYS[3], estimated); redis.call('EXPIRE', KEYS[3], ${MONTHLY_COUNTER_TTL_SECONDS}) end
if tonumber(ARGV[6]) then redis.call('INCRBY', KEYS[5], estimated); redis.call('EXPIRE', KEYS[5], ${LIFETIME_COUNTER_TTL_SECONDS}) end
if tonumber(ARGV[7]) then redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], ${CONCURRENCY_TTL_SECONDS}) end
if tonumber(ARGV[10]) then redis.call('INCR', KEYS[7]); redis.call('EXPIRE', KEYS[7], ${CONCURRENCY_TTL_SECONDS}) end
redis.call('HSET', KEYS[6], 'state', 'active', 'reserved', estimated, 'daily', tonumber(ARGV[4]) and KEYS[2] or '', 'monthly', tonumber(ARGV[5]) and KEYS[3] or '', 'lifetime', tonumber(ARGV[6]) and KEYS[5] or '', 'concurrent', tonumber(ARGV[7]) and '1' or '0', 'tenant_concurrent', tonumber(ARGV[10]) and '1' or '0', 'tenant_id', ARGV[11], 'api_key_id', ARGV[12], 'expires_at', tonumber(ARGV[1]) + tonumber(ARGV[13]))
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[14]))
return 0
`;

/**
 * RECONCILE — replaces the reservation's estimated token credit with actual
 * provider usage, atomically. Runs only on an `active` lease; reads which
 * counters the reservation credited from the lease hash, computes
 * `delta = actual - reserved`, validates the resulting counter values (no
 * negative drift), applies them, and decrements the held concurrency slots.
 * `actual` may be less than `reserved` (over-estimate refunded) or more
 * (under-estimate charged). Marks the lease `committed` — a second reconcile
 * or release is an idempotent no-op (`1`).
 */
export const RECONCILE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'committed' or state == 'released' then return 1 end
if state ~= 'active' then return -99 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved'))
local actual = tonumber(ARGV[1])
if not reserved or not actual or reserved < 0 or actual < 0 or reserved ~= math.floor(reserved) or actual ~= math.floor(actual) then return -99 end
local delta = actual - reserved
local updates = {}
for _, field in ipairs({'daily', 'monthly', 'lifetime'}) do
  local key = redis.call('HGET', KEYS[1], field)
  if key and key ~= '' then
    local value = tonumber(redis.call('GET', key))
    if not value or value < 0 or value + delta < 0 or value + delta ~= math.floor(value + delta) then return -99 end
    table.insert(updates, key)
  end
end
local concurrentKey = 'admission:concurrent:' .. ARGV[2]
local hasConcurrency = redis.call('HGET', KEYS[1], 'concurrent') == '1'
if hasConcurrency then
  local value = tonumber(redis.call('GET', concurrentKey))
  if not value or value < 1 or value ~= math.floor(value) then return -99 end
end
local tenantKey = ''
local hasTenantConcurrency = redis.call('HGET', KEYS[1], 'tenant_concurrent') == '1'
if hasTenantConcurrency then
  local tenantId = redis.call('HGET', KEYS[1], 'tenant_id')
  if not tenantId or tenantId == '' then return -99 end
  tenantKey = 'admission:tenant_concurrent:' .. tenantId
  local value = tonumber(redis.call('GET', tenantKey))
  if not value or value < 1 or value ~= math.floor(value) then return -99 end
end
-- INCRBY, never SET: a plain SET replaces the key and drops its TTL, so the
-- first reconcile after admission would strip the bucket's expiry and the
-- counter would outlive its window forever. INCRBY adjusts the value in place
-- and leaves the TTL intact. (KEEPTTL would also work but is unavailable on
-- the oldest Redis this is documented against.)
for _, key in ipairs(updates) do redis.call('INCRBY', key, delta) end
if hasConcurrency then redis.call('DECR', concurrentKey) end
if hasTenantConcurrency then redis.call('DECR', tenantKey) end
redis.call('HSET', KEYS[1], 'state', 'committed', 'actual', actual)
return 0
`;

/**
 * RELEASE — reverses an uncommitted reservation exactly once: refunds the
 * pre-credited token estimates, decrements the held concurrency and tenant
 * slots, and marks the lease `released` (subsequent release/reconcile
 * returns `1`). Unlike the normal release path, crash-recovery releases
 * (`releaseAdmissionLease` / the sweeper) run this same script keyed only by
 * the lease hash; concurrency keys are rebuilt from `admission:concurrent:`
 * + the lease's `api_key_id` / `tenant_id` fields, so recovery never needs
 * the caller to remember which counters were held.
 */
export const RELEASE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'released' or state == 'committed' then return 1 end
if state ~= 'active' then return -99 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved'))
if not reserved or reserved < 0 then return -99 end
for _, field in ipairs({'daily', 'monthly', 'lifetime'}) do local key = redis.call('HGET', KEYS[1], field); if key and key ~= '' then local value = tonumber(redis.call('GET', key) or '0'); if not value or value < reserved then return -99 end; redis.call('DECRBY', key, reserved) end end
if redis.call('HGET', KEYS[1], 'concurrent') == '1' then local key = 'admission:concurrent:' .. ARGV[1]; local value = tonumber(redis.call('GET', key) or '0'); if not value or value < 1 then return -99 end; redis.call('DECR', key) end
if redis.call('HGET', KEYS[1], 'tenant_concurrent') == '1' then local tenantId = redis.call('HGET', KEYS[1], 'tenant_id'); if not tenantId or tenantId == '' then return -99 end; local key = 'admission:tenant_concurrent:' .. tenantId; local value = tonumber(redis.call('GET', key) or '0'); if not value or value < 1 then return -99 end; redis.call('DECR', key) end
redis.call('HSET', KEYS[1], 'state', 'released')
return 0
`;
const RESULT_REASON: Record<number, AdmissionRejectionReason> = {
  [-1]: "rpm-exhausted",
  [-2]: "daily-token-limit",
  [-3]: "monthly-token-limit",
  [-4]: "lifetime-token-budget",
  [-5]: "concurrency-limit",
  [-6]: "tenant-capacity-exhausted",
};

export function assertResult(result: number, operation: string): void {
  if (result === -99) throw new Error(`corrupt admission counter during ${operation}`);
  const reason = RESULT_REASON[result];
  if (reason) {
    throw reasonToGatewayError(reason, { operation });
  }
  if (result < 0) throw new Error(`admission rejected during ${operation}: ${result}`);
}
