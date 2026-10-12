// Account identity enrichment sweep.
//
// Import stores the credential and nothing else that needs an upstream: the
// account is routable the moment the batch lands, which is what makes a paste
// of 40 credentials feel instant. Deriving a human label and the account email
// out of a JWT is cosmetic bookkeeping, so it happens here instead of on the
// request path — the same split the check-in ride-along already uses for work
// that only needs to be eventually correct.
//
// Registered as a ScheduledTaskRegistry task so the registry owns interval and
// re-entrancy; this function owns only the domain work.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { providerAccounts } from "../persistence/schema";
import { decryptCredentialToString } from "../security/crypto";
import { decodeJwtPayload } from "../providers/authentication/oauth-flow-store";
import { runSweep } from "./sweep-runner";

/** One account whose stored credential has never had its identity read. */
export interface UnenrichedAccount {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
}

export interface AccountIdentityEnrichmentSweepDeps {
  readonly db: CartethyiaDatabase;
  /**
   * How many accounts to enrich in one pass. Identity parsing is pure CPU on
   * an already-decrypted string, so this bounds a backlog rather than a
   * network fan-out.
   */
  readonly maxPerPass?: number;
  readonly onEnriched?: (accountId: string, label: string, email: string | undefined) => void;
  readonly onError?: (accountId: string, error: unknown) => void;
}

/** Identity claims a JWT may carry, in the order vendors use them. */
const EMAIL_CLAIMS = ["email", "preferred_username", "upn", "login"] as const;

/**
 * Reads the account's own identity out of its stored credential.
 *
 * Only a JWT carries claims; an API key has no identity to read and stays
 * unenriched, which is correct rather than a miss — there is nothing upstream
 * to learn about an opaque key.
 */
function readIdentity(secret: string): { email?: string; label?: string } {
  const payload = decodeJwtPayload(secret.trim());
  if (payload === undefined) return {};
  const email = EMAIL_CLAIMS.map((claim) => payload[claim]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const name = typeof payload["name"] === "string" && payload["name"].trim().length > 0
    ? payload["name"].trim()
    : undefined;
  return {
    ...(email === undefined ? {} : { email: email.trim() }),
    ...(name === undefined ? {} : { label: name }),
  };
}

/**
 * One non-overlapping enrichment sweep. Never rejects: the timer path has no
 * rejection channel, so every per-account failure is isolated here.
 *
 * An account is "unenriched" when its credential has never been parsed — the
 * column stays null until a sweep reads it, so an import never blocks on this
 * and a restart does not redo work that already succeeded.
 */
export async function accountIdentitySweep(
  deps: AccountIdentityEnrichmentSweepDeps,
): Promise<void> {
  const limit = deps.maxPerPass ?? 25;

  await runSweep<UnenrichedAccount>({
    name: "account-enrichment",
    list: async () => {
      const rows = await deps.db
        .select({
          id: providerAccounts.id,
          providerId: providerAccounts.providerId,
          label: providerAccounts.label,
        })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.status, "active"),
            isNull(providerAccounts.identityCheckedAt),
            sql`${providerAccounts.credentialCiphertext} IS NOT NULL`,
          ),
        )
        .limit(limit);
      return rows;
    },
    run: async (account) => {
      const rows = await deps.db
        .select({
          credentialCiphertext: providerAccounts.credentialCiphertext,
        })
        .from(providerAccounts)
        .where(eq(providerAccounts.id, account.id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return;

      let secret: string | undefined;
      try {
        secret =
          row.credentialCiphertext === null || row.credentialCiphertext === undefined
            ? undefined
            : decryptCredentialToString(row.credentialCiphertext);
      } catch (error) {
        // An undecryptable credential is a real problem, but not one this sweep
        // can fix. Stamp it so the pass stops retrying and the account's own
        // error surfaces where an operator looks for it.
        deps.onError?.(account.id, error);
        await markChecked(deps.db, account.id, {});
        return;
      }

      const identity = secret === undefined ? {} : readIdentity(secret);
      await markChecked(deps.db, account.id, identity);
      deps.onEnriched?.(account.id, identity.label ?? account.label, identity.email);
    },
    onItemError: (account, error) => {
      deps.onError?.(account.id, error);
    },
    maxConcurrency: 1,
  });

  // The sweep result is intentionally not returned: the registry path has no
  // consumer for per-pass counts, and a timer callback must not reject.
}

/**
 * Records that an account's credential has been read, and whatever it said.
 *
 * The stamp is what makes the sweep converge: an account is listed only while
 * `identityCheckedAt` is null, so a completed pass never re-reads a credential
 * it already parsed. The label is only overwritten when the JWT actually
 * carried a name — an operator-set label wins over a derived one.
 */
async function markChecked(
  db: CartethyiaDatabase,
  accountId: string,
  identity: { email?: string; label?: string },
): Promise<void> {
  await db
    .update(providerAccounts)
    .set({
      identityCheckedAt: new Date(),
      ...(identity.email === undefined ? {} : { accountEmail: identity.email }),
      ...(identity.label === undefined ? {} : { label: identity.label }),
    })
    .where(eq(providerAccounts.id, accountId));
}
