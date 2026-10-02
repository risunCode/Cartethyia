/**
 * Human labels for admin audit actions. Raw actions are namespaced operation
 * ids (`provider_account.circuit_force_closed`) — precise for filtering but
 * meaningless at a glance.
 *
 * Every action the backend emits has an explicit entry here; unknown future
 * actions fall back to {@link prettifyAuditAction} so the column never renders a
 * blank. That coverage is asserted by
 * `dashboard/test/shared/audit-labels.test.ts`, which holds the backend's emit
 * vocabulary as a literal and fails when a new action appears without a label —
 * the two lists are otherwise free to drift, because the `action` field is a plain
 * string with no enum behind it.
 *
 * Entries are also kept for actions no longer emitted (`filter_rule.*`,
 * `backup.reset`, `provider_account.circuit_force_closed`): the map labels ROWS,
 * and a historical row outlives the emit site that wrote it.
 */

const ACTION_LABELS: Readonly<Record<string, string>> = {
  "api_key.created": "API key created",
  "api_key.updated": "API key updated",
  "api_key.revoked": "API key revoked",
  "api_key.regenerated": "API key regenerated",
  "api_key.shared": "API key shared",
  "api_key.share_regenerated": "API key share link regenerated",
  "api_key.share_revoked": "API key unshared",
  "provider.created": "Provider created",
  "provider.updated": "Provider updated",
  "provider.deleted": "Provider deleted",
  "provider.global.updated": "Global provider updated",
  "provider.global.deleted": "Global provider deleted",
  "provider.routing.updated": "Provider routing updated",
  "provider.models.registered": "Provider models registered",
  "provider.models.bulk_deleted": "Provider models bulk-deleted",
  "provider.model.deleted": "Provider model deleted",
  "provider.model.enabled": "Provider model enabled",
  "provider.model.disabled": "Provider model disabled",
  "provider_account.created": "Provider account connected",
  "provider_account.updated": "Provider account updated",
  "provider_account.recovered": "Provider account recovered",
  "provider_account.revoked": "Provider account revoked",
  "provider_account.circuit_force_closed": "Provider account circuit force-closed",
  "provider_account.deleted": "Provider account deleted",
  "provider_account.exported": "Provider accounts exported (plaintext)",
  "provider_account.global.updated": "Global provider account updated",
  "provider_account.global.refreshed": "Global provider account refreshed",
  "provider_account.global.deleted": "Global provider account deleted",
  "model_alias.created": "Model alias created",
  "model_alias.updated": "Model alias updated",
  "model_alias.deleted": "Model alias deleted",
  "model_combo.created": "Model combo created",
  "model_combo.updated": "Model combo updated",
  "model_combo.cloned": "Model combo cloned",
  "model_combo.deleted": "Model combo deleted",
  "network_pool.created": "Network pool created",
  "network_pool.updated": "Network pool updated",
  "network_pool.deleted": "Network pool deleted",
  "network_pool.recovered": "Network pool recovered",
  "network_pool.strategy_updated": "Network pool strategy updated",
  "network_pool.relay_deployed": "Network pool relay deployed",

  "filter_rule.created": "Filter rule created",
  "filter_rule.updated": "Filter rule updated",
  "filter_rule.deleted": "Filter rule deleted",
  "filter_rule.reordered": "Filter rules reordered",
  "filter_rule.master_toggle": "Filter master switch toggled",
  "settings.runtime.updated": "Runtime settings updated",
  "cli_tool.mappings_saved": "CLI tool mappings saved",
  "cli_tool.mappings_reset": "CLI tool mappings reset",
  "cli_tool.applied": "CLI tool applied",
  "studio.session.created": "Studio session created",
  "studio.session.updated": "Studio session updated",
  "studio.session.deleted": "Studio session deleted",
  "console.password_changed": "Console password changed",
  "console_logs.cleared": "Console logs cleared",
  "security.ip_banned": "IP banned",
  "backup.reset": "Backup reset",
};

const ACRONYMS: Readonly<Record<string, string>> = {
  api: "API",
  ip: "IP",
  cli: "CLI",
  oauth: "OAuth",

};

/** Fallback prettifier for actions without an explicit entry. */
export function prettifyAuditAction(action: string): string {
  return action
    .split(".")
    .map((part) =>
      part
        .split(/[_-]+/)
        .filter(Boolean)
        .map((word) => ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    )
    .join(" · ");
}

/** Human label for an audit action id; raw id stays available via tooltip. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? prettifyAuditAction(action);
}
