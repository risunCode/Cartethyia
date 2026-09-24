# Workers

Bounded periodic maintenance: a shared scheduler plus domain workers. The
registry owns timers, re-entrancy, and logging; each task owns only its domain
work. All tasks run on unref'd intervals and must be safe to skip, overlap, or
re-run.

## Layout

```
src/workers/
  tasks.ts                 # ScheduledTaskRegistry: register/start/stop/runNow
  oauth-refresh-worker.ts  # oauthRefreshSweep: proactive OAuth token refresh
  quota-refresh-worker.ts  # quotaRefreshSweep: keeps the quota cache warm
  daily-checkin.ts         # attemptDailyGrowthPass: once-per-day credit claim + growth report
```

Task wiring lives in `runtime/dependencies.ts` (`buildProductionDeps`), which
registers every task. `scheduledTasks.start()` is called by `main.ts` once the
listener is up, so the first tick of the lease and health sweeps cannot run
before the process is serving traffic.

## Scheduler semantics (`tasks.ts`)

- `register(task)` appends a `{ name, intervalMs, run }` entry; `start()` puts
  each on its own `setInterval` timer. `start()` is idempotent: calling it
  while timers run schedules nothing new, so hot reloads cannot stack
  duplicate sweeps. `stop()` clears all timers and awaits in-flight runs via
  `Promise.allSettled`.
- `runOnce` skips a tick when that task name is already running (overlap-skip),
  tracks the run in `inFlight` so `stop()` drains cleanly, and logs failures
  as `[scheduled-task:<name>] failed` without propagating.
- `runNow(name)` runs one task immediately, bypassing its interval, for tests
  and manual triggers.

## Task table

| Name | Interval | Work | Only when |
| --- | --- | --- | --- |
| `lease-sweep` | 30 s | `sweepLeases(redis)` reaps expired admission leases | Redis configured |
| `account-health-sweep` | 30 s | `sweepExpiredCooldowns(db)` and `sweepExpiredPoolCooldowns(db)` recover expired account/pool cooldowns, then invalidate the route snapshot if either recovered | always |
| `telemetry-payload-cleanup` | 15 min | `payloadCapture.cleanupExpired()` deletes expired payload rows and compacts `.jsonb` frames | always |
| `telemetry-retention` | 6 h | `telemetryStore.pruneTelemetry` drops metadata older than `CARTETHYIA_TELEMETRY_RETENTION_DAYS` (default 30 days) | always |
| `runtime-metrics` | 10 s | `RuntimeMetricsSampler.sample()` records memory + collection-size gauges | always |
| `oauth-refresh-sweep` | 60 s | `oauthRefreshSweep` proactively refreshes due OAuth accounts | always |
| `quota-refresh-sweep` | 60 s | `quotaRefreshSweep` refills stale provider-quota cache entries | Redis configured |

## Daily check-in ride-along (`daily-checkin.ts`)

Claims the free daily credit grant WorkBuddy/CodeBuddy grant once per calendar
day, per account. The sweep prints one combined quota + check-in line per
account, and skips a line identical to that account's previous one. The
following behavior is the contract implemented by `attemptDailyGrowthPass()`
and its quota-sweep caller:

**It has no timer of its own.** It rides along with the 60 s
`quota-refresh-sweep`, which already resolves a fresh credential for each
account; a second scheduled task would duplicate that work for a once-a-day
action. `quotaRefreshSweep` calls `attemptDailyGrowthPass()` per eligible
account after each refresh wave, bounded by `maxCheckinsPerPass` (default 10,
`0` disables).

1. Eligibility is `supportsDailyCheckin(providerId)` — `workbuddy`, `cb`,
   `cbcn`. Everything else is skipped without any upstream traffic.
2. Each account reserves its calendar-day slot with `SET NX EX` on
   `cartethyia:daily-checkin:<day>:<accountId>`. The sweep runs every 60 s, but
   the slot guarantees **one attempt per account per day**: winning it means
   doing the work, losing it returns `null` and costs zero requests. A Redis
   failure falls through to the attempt rather than forfeiting the grant, and
   an errored attempt **releases** the slot so a later pass retries today.
3. Per account, `fetchDailyCheckin()` probes
   `POST …/billing/meter/checkin-activity-status` first and only POSTs
   `…/billing/meter/daily-checkin` when the account has not claimed today. An
   already-claimed account therefore costs one request, not two. Business code
   `1001` on the claim also maps to `already_claimed` (not `10001` — that
   belongs to the artifact-release API), as do prose variants the gateway can
   answer instead (`已签到`, `already…check…`). The claim POST retries transient
   5xx/network failures twice (1 s, 2 s backoff); business codes never retry.
4. On a non-error check-in the sweep runs the growth pass second
   (`attemptDailyGrowthPass` in `daily-checkin.ts`): one `POST …/v2/report`
   `chat_request_send` event lighting the login streak, same order as the
   dashboard's growth button. The event scores by uid, and only a JWT carries
   one — an opaque API-key credential fails the report leg closed rather than
   reporting under another account's uid. A report-side failure never releases
   the day slot: the credit grant is the valuable half, and the report retries
   tomorrow instead of spinning every sweep pass today.

   **Only the buddy gateways are eligible.** The route exists on those three and
   nowhere else, so any other provider is deliberately absent from
   `supportsDailyCheckin` — an eligible flag would spend a day slot and an
   upstream request on a wire that does not exist.

   The three buddy gateways share the billing route but not the wire shape, so
   the module adapts per provider: `workbuddy` is a bare base URL (it prepends
   `/v2`) and takes the desktop WorkBuddy identity; `cb` uses `www.codebuddy.ai`
   with the `IDE` identity; `cbcn` uses `copilot.tencent.com` with `CLI`. CN
   also double-wraps its payload as `data.Response.Data` (same envelope as its
   quota endpoint), which the reader unwraps.
5. Each outcome is logged as `[Quota-refresh] provider/label quota …, daily …, activity …`
   with credit/streak when present, unless the composed line is identical to
   that account's previous one — a steady pass stays quiet. The `activity …`
   phrase appears only when the report leg ran. Errors are logged, never
   rethrown; the sweep's `onTick` reports the check-in count alongside the
   quota tallies.

A transient failure releases the account's day marker itself (see the two
`redis.del(ledgerKey(...))` release points in `attemptDailyGrowthPass`), so the
next sweep of the same day retries the account. There is no operator-facing
reset entry point: re-running the pass is the retry.

**Trade-off:** coverage follows the quota sweep, so an account is only checked
in once the sweep considers it due (OAuth account with a registered refresher).
All three eligible providers are OAuth, so in practice every stored
workbuddy/cb/cbcn account is covered; a purely API-key account of those
providers would not be. Say the word if you want those covered too and it
becomes its own target list.


## OAuth refresh sweep (`oauth-refresh-worker.ts`)

1. `loadDueAccounts` (`loadDueOAuthAccounts(db)`) lists accounts due for
   refresh; a load failure logs `[oauth-refresh] sweep failed to load due
   accounts` and ends the pass.
2. Eligible accounts run in completed waves of 2, then 3, then 4, then 5
   (or the configured maximum), so the next wave waits for the previous one
   to settle instead of continuously filling worker slots.
3. Per account, `resolveRefresher(providerId)` resolves the provider's
   token-endpoint client; accounts with no registered refresher are skipped.
   Otherwise `refreshService.ensureFreshAccessToken(account.id, refresher,
   { skewMs })` refreshes ahead of expiry.
4. Per-account errors are isolated into `onAccountError` (wired to log
   `[oauth-refresh] account=<id> provider=<id> failed`), and `onTick({ due,
   attempted })` reports the pass summary. `attempted` counts only accounts
   with a refresher.

## Quota refresh sweep (`quota-refresh-worker.ts`)

Keeps OAuth-backed accounts with a registered token refresher and quota
collector warm so opening the Quota page is a cache read instead of a cold
upstream fan-out. One bounded pass per tick:

1. `listTargets` (default `listOAuthQuotaRefreshTargets`) selects OAuth
   accounts; providers without a registered token-endpoint refresher are
   skipped before cache reads or upstream work. API-key and credential-less
   accounts are never sweep targets.
2. Each eligible candidate's cache age is read; entries younger than `minAgeMs`
   (default 4 min, under the 300 s cache TTL) are skipped. An unreadable entry
   counts as due, which is the safe direction.
3. Due accounts are sorted oldest-first and capped at `maxPerPass` (default
   40), so a pass that runs out of `passBudgetMs` (default 90 s) spends it on
   the stalest accounts rather than whatever the database returned first.
4. Remaining accounts refresh in completed waves of 2, then 3, then 4, then 5
   (or the configured maximum), waiting for each wave to settle before starting
   the next. Every refresh uses the shared `refreshAccountQuota`, so the sweep
   and a manual click share one fetch for the same account.

Per-account failures are counted and logged, never rethrown: the registry's
error path is a backstop, not a channel. `onTick` reports
`{ targets, attempted, skipped, failed, checkins }`.

## Rules / invariants

- Keep timer/re-entrancy/logging behavior in the registry; keep provider, DB,
  and Redis details in the task or worker function.
- Tasks must be idempotent and tolerant of skipped or overlapping ticks; the
  overlap-skip is best-effort, not a correctness lock.
- A task's `run()` must never need to throw to signal trouble: handle and log
  domain errors inside the task (the registry logs anything that escapes, but
  that path is a backstop, not a channel).
- Do not hold the event loop open: scheduler timers are unref'd, and new
  background work should follow the same pattern so idle processes can exit.
- Register tasks in `buildProductionDeps` next to the dependencies they close
  over; the sampler's closure-based sources are the model for keeping the
  observability boundary one-directional.
