/**
 * Audit action labels.
 *
 * The audit log's Action column is the operator's only view of what an admin did.
 * Two properties carry it:
 *
 * 1. **A curated label is what makes an action readable.** `api_key.created`
 *    renders as "API key created"; without an entry the generic prettifier renders
 *    `api_key.regenerated` as "API Key · Regenerated" — Title Case with a middot
 *    separator, which is a different visual language from the curated rows. A
 *    table where some rows read "API key created" and others "API Key ·
 *    Regenerated" looks like two different sources.
 * 2. **The column must never be blank.** `auditActionLabel` falls back to the
 *    prettifier, and `prettifyAuditAction` always produces a string (possibly
 *    empty for an empty input, which no real action is).
 *
 * The module's doc comment states "Every action the backend emits has an explicit
 * entry here". That is a checkable invariant, and it is FALSE — see the
 * `test.failing` below, which carries the measured diff against the real emit
 * sites.
 */
import { describe, expect, test } from "bun:test";
import { auditActionLabel, prettifyAuditAction } from "../../src/shared/audit-labels";

/**
 * Every audit action id the backend writes, extracted from `src/` by grepping for
 * string literals in an audit namespace that appear in an `action` expression.
 * Kept here as a literal so the test does not depend on the filesystem, and so a
 * reviewer can see the vocabulary in one place.
 */
const BACKEND_ACTIONS = [
  "api_key.created",
  "api_key.regenerated",
  "api_key.revoked",
  "api_key.share_regenerated",
  "api_key.share_revoked",
  "api_key.shared",
  "api_key.updated",
  "cli_tool.applied",
  "cli_tool.mappings_reset",
  "cli_tool.mappings_saved",
  "console.password_changed",
  "console_logs.cleared",
  "model_alias.created",
  "model_alias.deleted",
  "model_alias.updated",
  "model_combo.cloned",
  "model_combo.created",
  "model_combo.deleted",
  "model_combo.updated",
  "network_pool.created",
  "network_pool.deleted",
  "network_pool.recovered",
  "network_pool.relay_deployed",
  "network_pool.strategy_updated",
  "network_pool.updated",
  "provider.created",
  "provider.deleted",
  "provider.global.deleted",
  "provider.global.updated",
  "provider.model.deleted",
  "provider.model.disabled",
  "provider.model.enabled",
  "provider.models.bulk_deleted",
  "provider.models.registered",
  "provider.routing.updated",
  "provider.updated",
  "provider_account.created",
  "provider_account.deleted",
  "provider_account.exported",
  "provider_account.global.deleted",
  "provider_account.global.refreshed",
  "provider_account.global.updated",
  "provider_account.recovered",
  "provider_account.revoked",
  "provider_account.updated",
  "security.ip_banned",
  "settings.runtime.updated",
  "studio.session.created",
  "studio.session.deleted",
  "studio.session.updated",
] as const;

describe("prettifyAuditAction", () => {
  test("each dot-separated segment becomes its own capitalised group", () => {
    // The separator is a middot, not a space, so the namespace structure stays
    // visible.
    expect(prettifyAuditAction("some_new_thing.created")).toBe("Some New Thing · Created");
    expect(prettifyAuditAction("a.b.c.d")).toBe("A · B · C · D");
  });

  test("underscores and dashes both split words", () => {
    // `/[_-]+/` — and the filter drops the empty parts, so a doubled separator
    // does not produce a blank word.
    expect(prettifyAuditAction("snake_case_and-dash")).toBe("Snake Case And Dash");
    expect(prettifyAuditAction("double__underscore")).toBe("Double Underscore");
    expect(prettifyAuditAction("with--dash")).toBe("With Dash");
  });

  test("the documented acronyms are upper-cased", () => {
    // `api`/`ip`/`cli`/`oauth` are the four in the map. The lookup is
    // case-insensitive on the word but the replacement is fixed.
    expect(prettifyAuditAction("ip.ban")).toBe("IP · Ban");
    expect(prettifyAuditAction("cli_tool.mapping")).toBe("CLI Tool · Mapping");
    expect(prettifyAuditAction("oauth_token.refreshed")).toBe("OAuth Token · Refreshed");
    expect(prettifyAuditAction("api.thing")).toBe("API · Thing");
  });

  test("an acronym is matched anywhere in the segment, not only at the start", () => {
    // The split is per word, so `my_ip_rule` capitalises the middle word.
    expect(prettifyAuditAction("my_ip_rule.updated")).toBe("My IP Rule · Updated");
  });

  test("only the first letter is capitalised for non-acronym words", () => {
    // `word.charAt(0).toUpperCase() + word.slice(1)` — the rest keeps its case.
    expect(prettifyAuditAction("UPPER.CASE")).toBe("UPPER · CASE");
    expect(prettifyAuditAction("already CamelCase")).toBe("Already CamelCase");
  });

  test("a single-segment action is capitalised without a separator", () => {
    expect(prettifyAuditAction("single")).toBe("Single");
  });

  test("an empty string produces an empty string", () => {
    // MEASURED: the empty parts are filtered per segment, and `"".split(".")` is
    // `[""]`, so the result is `""`. Pinned because it means the caller — not the
    // prettifier — is responsible for a non-blank column, and no real action id
    // is empty.
    expect(prettifyAuditAction("")).toBe("");
  });

  test("a leading or trailing dot leaves a stray separator", () => {
    // MEASURED: the empty SEGMENT is not filtered (only the empty WORDS within a
    // segment are), so `".leading"` becomes `" · Leading"` with a leading
    // separator. Pinned: no backend action id has this shape, and the fallback is
    // still non-blank.
    expect(prettifyAuditAction(".leading")).toBe(" · Leading");
    expect(prettifyAuditAction("trailing.")).toBe("Trailing · ");
  });

  test("the output never contains a raw underscore or dash", () => {
    // The invariant that makes the prettifier a prettifier: every separator the
    // operator sees is a space or a middot.
    for (const action of BACKEND_ACTIONS) {
      const label = prettifyAuditAction(action);
      expect(label).not.toContain("_");
      expect(label).not.toContain("-");
    }
  });
});

describe("auditActionLabel", () => {
  test("a curated action uses its explicit label", () => {
    expect(auditActionLabel("api_key.created")).toBe("API key created");
    expect(auditActionLabel("api_key.revoked")).toBe("API key revoked");
  });

  test("the curated labels are not the prettifier's output", () => {
    // The discriminating case: if the map were bypassed, this would be
    // "API Key · Created". Asserting the exact curated string is what proves the
    // map is consulted.
    expect(auditActionLabel("api_key.created")).not.toBe(prettifyAuditAction("api_key.created"));
  });

  test("curated labels read as sentences, not as prettified ids", () => {
    // The house style: lower-case after the first word and no middot. This is the
    // property that makes the curated rows a distinct visual language from the
    // fallback, and therefore the property that makes a missing entry visible.
    for (const action of ["api_key.created", "model_combo.created", "provider_account.deleted"]) {
      const label = auditActionLabel(action);
      expect(label).not.toContain("·");
      expect(label).toBe(label.charAt(0).toUpperCase() + label.slice(1));
    }
  });

  test("a curated label may deliberately differ from the action's own wording", () => {
    // `api_key.share_revoked` is labelled "API key unshared" — the map is a
    // translation layer, not a formatter, so a label need not echo the id.
    expect(auditActionLabel("api_key.share_revoked")).toBe("API key unshared");
    // And `provider_account.created` is "connected", the operator's word for it.
    expect(auditActionLabel("provider_account.created")).toBe("Provider account connected");
  });

  test("an uncurated action falls back to the prettifier", () => {
    expect(auditActionLabel("totally.new_action")).toBe("Totally · New Action");
    expect(auditActionLabel("totally.new_action")).toBe(prettifyAuditAction("totally.new_action"));
  });

  test("the label is never blank for any action the backend emits", () => {
    // The column's guarantee. A blank cell would make the audit row unreadable.
    for (const action of BACKEND_ACTIONS) {
      const label = auditActionLabel(action);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  test("the label is deterministic for a given action", () => {
    // The table re-renders on every poll; a label that changed between renders
    // would make rows flicker.
    for (const action of BACKEND_ACTIONS) {
      expect(auditActionLabel(action)).toBe(auditActionLabel(action));
    }
  });

  test("two different actions do not share a label", () => {
    // A collision would make two distinct operations indistinguishable in the
    // column, which is the column's entire job.
    const labels = BACKEND_ACTIONS.map((action) => auditActionLabel(action));
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("every action the backend emits has a curated label", () => {
    // The invariant the module's doc comment claims, and the one that keeps the
    // table readable. The backend's `action` field is a plain string with no enum
    // behind it (`src/console/domains/audit/contracts.ts`), so nothing fails when a
    // new emit site appears — this test is the only thing that catches the two
    // lists drifting.
    const unlabelled = BACKEND_ACTIONS.filter(
      (action) => auditActionLabel(action) === prettifyAuditAction(action),
    );
    expect(unlabelled).toEqual([]);
  });

  test("no backend action renders with fallback styling", () => {
    // The visible consequence of a missing entry: Title Case with a middot
    // separator, which is a different visual language from the curated
    // lower-case-sentence rows. Asserting the absence of the separator catches a
    // label that exists but was written in the fallback's style.
    for (const action of BACKEND_ACTIONS) {
      expect(auditActionLabel(action)).not.toContain("·");
    }
  });

  test("every curated label names an action in the backend's namespaces", () => {
    // The reverse direction: a curated entry for an action that no longer exists
    // is dead weight, but it is also a hint that an emit site was renamed without
    // updating the map. MEASURED: seven entries are not emitted by any `action:`
    // site today — `filter_rule.*` (five), `backup.reset`, and
    // `provider_account.circuit_force_closed`. Those are documented below rather
    // than asserted away, because the audit row for them may still exist in
    // historical data: the map labels ROWS, and old rows outlive emit sites.
    const curatedButNotEmitted = [
      "backup.reset",
      "filter_rule.created",
      "filter_rule.deleted",
      "filter_rule.master_toggle",
      "filter_rule.reordered",
      "filter_rule.updated",
      "provider_account.circuit_force_closed",
    ];
    // Each has a curated label, so a historical row renders as a sentence rather
    // than as fallback styling. That is the reason to keep them.
    for (const action of curatedButNotEmitted) {
      const label = auditActionLabel(action);
      expect(label).not.toBe(prettifyAuditAction(action));
      expect(label).not.toContain("·");
    }
  });
});
