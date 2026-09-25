import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ModelPickerModal } from "./ModelPicker";
import { TENANT_KEY_SCOPES, type ApiKeyResponse, type TenantScope } from "../lib/contracts";

/**
 * What each assignable scope actually permits, as a tooltip on the checkbox.
 *
 * The catalog scopes are spelled out because their separation from
 * `dashboard:write` is the point: a key minted to read usage must not thereby
 * be able to add an upstream or delete a model.
 */
const SCOPE_DESCRIPTIONS: Record<TenantScope, string> = {
  "routing:invoke": "Call /v1/* gateway routes within this tenant.",
  "routing:cli_mapping": "Resolve persisted CLI source→target model mappings.",
  "dashboard:read": "Read this tenant's configuration and usage.",
  "dashboard:write": "Modify this tenant's configuration.",
  "providers:read": "Read provider rows, including accounts.",
  "providers:write": "Add, modify, or delete provider rows and their credentials.",
  "models:read": "Read catalog model rows.",
  "models:write": "Add, modify, or delete catalog model rows.",
};

type TokenBudgetMode = "recurring" | "one-time";
const TOKEN_SUFFIX: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};
/** Quick-pick token budgets offered next to every token limit input. */
const TOKEN_BUDGET_PRESETS = [
  { label: "1M", amount: 1_000_000, description: "1 million" },
  { label: "100M", amount: 100_000_000, description: "100 million" },
  { label: "1B", amount: 1_000_000_000, description: "1 billion" },
  { label: "1T", amount: 1_000_000_000_000, description: "1 trillion" },
] as const;
function parseTokenLimit(value: string): number | undefined {
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  const m = raw.match(/^([\d.]+)\s*([kmbt])?$/);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const mul = m[2] ? (TOKEN_SUFFIX[m[2]] ?? 1) : 1;
  return Math.round(num * mul);
}
function tokenInputValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const preset = TOKEN_BUDGET_PRESETS.find((entry) => entry.amount === value);
  if (preset) return preset.label;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}
function parseLimit(value: string): number | undefined {
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
function parseLimitOrNull(value: string): number | null | undefined {
  const n = parseLimit(value);
  // Empty input clears an existing limit; a parsed value is kept.
  return value.trim() === "" ? null : n;
}

/** Token limit input with 1M/100M/1B/1T quick-pick presets. */
function TokenBudgetField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const parsed = parseTokenLimit(value);
  const selected = TOKEN_BUDGET_PRESETS.find((preset) => preset.amount === parsed)?.label;
  return (
    <div>
      <Input
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. 1M, 500K"
        disabled={disabled}
      />
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}
        role="group"
        aria-label={`${label} presets`}
      >
        {TOKEN_BUDGET_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={selected === preset.label}
            aria-label={`${preset.label}, ${preset.description} tokens`}
            onClick={() => onChange(preset.label)}
            disabled={disabled}
            style={{
              padding: "2px 8px",
              borderRadius: "6px",
              fontSize: "10px",
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
              border: `1px solid ${selected === preset.label ? "var(--accent)" : "var(--inner-border)"}`,
              background: selected === preset.label ? "var(--accent-soft)" : "transparent",
              color: selected === preset.label ? "var(--accent)" : "var(--text-tertiary)",
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface KeyFormInput {
  label: string;
  keyMode: ApiKeyResponse["keyMode"];
  keyPrefix?: string;
  key?: string;
  modelAllowlist: string[];
  providerAllowlist: string[];
  scopes: string[];
  requestsPerMinute?: number | null;
  maxConcurrentRequests?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  lifetimeTokenBudget?: number | null;
  notesTitle?: string;
  notesSubtitle?: string;
  notesBody?: string;
}
interface KeyFormProps {
  mode: "create" | "edit";
  record: ApiKeyResponse | null;
  busy: boolean;
  onDone: (input: KeyFormInput) => void;
  onClose: () => void;
}
export function keyCredentialFields(
  keyMode: ApiKeyResponse["keyMode"],
  customKey: string,
  keyPrefix: string,
): Pick<KeyFormInput, "keyMode" | "key" | "keyPrefix"> {
  const key = keyMode === "personal" ? customKey.trim() : "";
  return {
    keyMode,
    keyPrefix: keyPrefix.trim() || undefined,
    ...(key ? { key } : {}),
  };
}
export function oneTimeSecretForMode(keyMode: ApiKeyResponse["keyMode"], secret: string | undefined): string | null {
  return keyMode === "personal" ? secret ?? null : null;
}
export function ApiKeyForm({ mode, record, busy, onDone, onClose }: KeyFormProps): ReactNode {
  const [label, setLabel] = useState(record?.label ?? "");
  const [prefix, setPrefix] = useState(record?.keyPrefix ?? "");
  const [customKey, setCustomKey] = useState("");
  const [rpm, setRpm] = useState(record?.requestsPerMinute?.toString() ?? "");
  const [daily, setDaily] = useState(
    tokenInputValue(
      (record as unknown as { dailyTokenLimit?: number | null })?.dailyTokenLimit ?? null,
    ),
  );
  const [monthly, setMonthly] = useState(
    tokenInputValue(
      (record as unknown as { monthlyTokenLimit?: number | null })?.monthlyTokenLimit ?? null,
    ),
  );
  const [lifetime, setLifetime] = useState(
    tokenInputValue(
      (record as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget ?? null,
    ),
  );
  const [budgetMode, setBudgetMode] = useState<TokenBudgetMode>(
    (record as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget != null
      ? "one-time"
      : "recurring",
  );
  const [concurrent, setConcurrent] = useState(record?.maxConcurrentRequests?.toString() ?? "");
  const [scopes, setScopes] = useState<string[]>(() => {
    const s = (record as unknown as { scopes?: string[] })?.scopes;
    return s && s.length ? [...s] : ["routing:invoke"];
  });
  const [models, setModels] = useState<string[]>(() => {
    const m = (record as unknown as { modelAllowlist?: string[] | null })?.modelAllowlist;
    return m ? [...m] : [];
  });
  const [providerAllowlist, setProviderAllowlist] = useState(() => {
    const p = (record as unknown as { providerAllowlist?: string[] | null })?.providerAllowlist;
    return p ? p.join(", ") : "";
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notesTitle, setNotesTitle] = useState(() => {
    const t = (record as unknown as { notesTitle?: string | null })?.notesTitle;
    return t ?? "";
  });
  const [notesSubtitle, setNotesSubtitle] = useState(() => {
    const s = (record as unknown as { notesSubtitle?: string | null })?.notesSubtitle;
    return s ?? "";
  });
  const [notesBody, setNotesBody] = useState(() => {
    const b = (record as unknown as { notesBody?: string | null })?.notesBody;
    return b ?? "";
  });
  const [keyMode, setKeyMode] = useState<ApiKeyResponse["keyMode"]>(
    record?.keyMode ?? "personal",
  );
  const isOneTime = budgetMode === "one-time";
  const toggleScope = (scope: string) =>
    setScopes((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]));
  const submit = () => {
    const providers = providerAllowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onDone({
      label: label.trim(),
      ...keyCredentialFields(keyMode, customKey, prefix),
      scopes,
      modelAllowlist: models,
      providerAllowlist: providers,
      requestsPerMinute: parseLimitOrNull(rpm),
      maxConcurrentRequests: parseLimitOrNull(concurrent),
      dailyTokenLimit: isOneTime ? null : (parseTokenLimit(daily) ?? null),
      monthlyTokenLimit: isOneTime ? null : (parseTokenLimit(monthly) ?? null),
      lifetimeTokenBudget: isOneTime ? (parseTokenLimit(lifetime) ?? null) : null,
      notesTitle: notesTitle.trim(),
      notesSubtitle: notesSubtitle.trim(),
      notesBody: notesBody.trim(),
    });
  };
  return (
    <div className="modal-form-layout" style={{ paddingBottom: "4px" }}>
      <section className="modal-form-section-wide" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>Credential mode</h3>
        <div role="group" aria-label="Credential mode" style={{ display: "flex", gap: "8px" }}>
          {(["personal", "share"] as const).map((modeOption) => (
            <button key={modeOption} type="button" aria-pressed={keyMode === modeOption}
              disabled={busy} onClick={() => setKeyMode(modeOption)}
              style={{ border: "1px solid var(--inner-border)", borderRadius: "8px", padding: "8px 12px",
                color: keyMode === modeOption ? "var(--accent)" : "var(--text-secondary)",
                background: keyMode === modeOption ? "var(--accent-soft)" : "var(--surface-2)", cursor: "pointer" }}>
              {modeOption === "personal" ? "Personal" : "Share template"}
            </button>
          ))}
        </div>
        <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
          {keyMode === "share"
            ? "A share template does not authenticate requests. Recipients generate their own child key from its public enrollment page."
            : record?.keyMode === "share"
              ? "Converting this template to a personal key revokes all child keys and enrollment links. A new personal secret will be shown once."
              : "A personal key authenticates requests directly; its secret is shown once when created or rotated."}
        </p>
      </section>
      {mode === "create" && (
        <section className="modal-form-section-wide" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>Identity</h3>
            <p style={{ marginTop: "2px", fontSize: "11px", color: "var(--text-tertiary)" }}>
              Give this credential a recognizable name.
            </p>
          </div>
          <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="ci-key…" disabled={busy} autoFocus />
            <Input label="Key prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)}
              placeholder="rk_ (default)…" disabled={busy || customKey.trim().length > 0} />
          </div>
          {keyMode === "personal" && (
            <Input label="Custom API key value (optional)" value={customKey}
              onChange={(e) => setCustomKey(e.target.value)} placeholder="Leave blank to generate…" disabled={busy} />
          )}
        </section>
      )}
      {mode === "edit" && (
        <section className="modal-form-section" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
              Identity
            </h3>
            <p style={{ marginTop: "2px", fontSize: "11px", color: "var(--text-tertiary)" }}>
              Update the label for this credential.
            </p>
          </div>
          <div
            style={{
              display: "grid",
              gap: "12px",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            }}
          >
            <Input
              label="Name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="ci-key…"
              disabled={busy}
              autoFocus
            />
          </div>
        </section>
      )}
      <section className="modal-form-section" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
            Limits
          </h3>
          <p style={{ marginTop: "2px", fontSize: "11px", color: "var(--text-tertiary)" }}>
            Keep this credential predictable under load.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gap: "12px",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          }}
        >
          <Input
            label="Requests per minute"
            type="number"
            min="0"
            value={rpm}
            onChange={(e) => setRpm(e.target.value)}
            placeholder="Unlimited…"
            disabled={busy}
          />
          <Input
            label="Max concurrent requests"
            type="number"
            min="0"
            value={concurrent}
            onChange={(e) => setConcurrent(e.target.value)}
            placeholder="Unlimited…"
            disabled={busy}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            borderRadius: "12px",
            border: "1px solid var(--inner-border)",
            background: "var(--surface-2)",
            padding: "10px 12px",
          }}
        >
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)" }}>
              Token budget
            </div>
            <p style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--text-tertiary)" }}>
              {isOneTime
                ? "One-time cap; it does not reset."
                : "Daily and monthly limits reset automatically."}
            </p>
          </div>
          <div
            style={{
              display: "flex",
              gap: "4px",
              padding: "2px",
              borderRadius: "8px",
              background: "var(--surface-1)",
              border: "1px solid var(--inner-border)",
            }}
          >
            <button
              type="button"
              onClick={() => setBudgetMode("recurring")}
              disabled={busy}
              style={{
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "10.5px",
                fontWeight: 600,
                background: !isOneTime ? "var(--accent-soft)" : "transparent",
                color: !isOneTime ? "var(--accent)" : "var(--text-tertiary)",
                border: "none",
                cursor: "pointer",
              }}
            >
              Recurring
            </button>
            <button
              type="button"
              onClick={() => setBudgetMode("one-time")}
              disabled={busy}
              style={{
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "10.5px",
                fontWeight: 600,
                background: isOneTime ? "var(--accent-soft)" : "transparent",
                color: isOneTime ? "var(--accent)" : "var(--text-tertiary)",
                border: "none",
                cursor: "pointer",
              }}
            >
              One-time
            </button>
          </div>
        </div>
        {isOneTime ? (
          <TokenBudgetField
            label="One-time token limit"
            value={lifetime}
            onChange={setLifetime}
            disabled={busy}
          />
        ) : (
          <div
            style={{
              display: "grid",
              gap: "12px",
              gridTemplateColumns: "1fr 1fr",
            }}
          >
            <TokenBudgetField
              label="Daily token limit"
              value={daily}
              onChange={setDaily}
              disabled={busy}
            />
            <TokenBudgetField
              label="Monthly token limit"
              value={monthly}
              onChange={setMonthly}
              disabled={busy}
            />
          </div>
        )}
      </section>
      <section
        className="modal-form-section"
        style={{ display: "flex", flexDirection: "column", gap: "12px" }}
      >
        <div>
          <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
            Share notes
          </h3>
          <p style={{ marginTop: "2px", fontSize: "11px", color: "var(--text-tertiary)" }}>
            Optional copy shown on the public share page.
          </p>
        </div>
        <Input
          label="Title"
          value={notesTitle}
          onChange={(e) => setNotesTitle(e.target.value)}
          placeholder="e.g. Bansos Token"
          disabled={busy}
        />
        <Input
          label="Subtitle"
          value={notesSubtitle}
          onChange={(e) => setNotesSubtitle(e.target.value)}
          placeholder="e.g. Come and save your tokens"
          disabled={busy}
        />
        <Input
          label="Body"
          value={notesBody}
          onChange={(e) => setNotesBody(e.target.value)}
          placeholder="Free-form notes for the recipient"
          disabled={busy}
        />
      </section>
      <section
        className="modal-form-section-wide"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "12px",
          borderRadius: "12px",
          border: "1px solid var(--inner-border)",
          background: "var(--surface-2)",
        }}
      >
        <div>
          <h3 style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
            Access
          </h3>
          <p style={{ marginTop: "2px", fontSize: "11px", color: "var(--text-tertiary)" }}>
            Whitelist — if set, every other model is denied. Leave empty to allow all.
          </p>
        </div>
        <div>
          <label
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              display: "block",
              marginBottom: "6px",
            }}
          >
            Allowed models
          </label>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
            {models.length === 0 ? (
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                All models allowed
              </span>
            ) : (
              models.map((m) => (
                <span
                  key={m}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    background: "var(--accent-soft)",
                    color: "var(--accent)",
                    padding: "2px 8px",
                    borderRadius: "6px",
                    border: "1px solid var(--accent)",
                  }}
                >
                  {m}
                  <button
                    type="button"
                    onClick={() => setModels((prev) => prev.filter((x) => x !== m))}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      display: "flex",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
          >
            Browse models
          </Button>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={models}
            onToggle={(v) =>
              setModels((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
            }
            title="Select allowed models"
            multi
          />
        </div>
        <Input
          label="Provider allowlist (comma-separated)"
          value={providerAllowlist}
          onChange={(e) => setProviderAllowlist(e.target.value)}
          placeholder="openai, anthropic"
          disabled={busy}
        />
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {TENANT_KEY_SCOPES.map((scope) => (
            <label
              key={scope}
              title={SCOPE_DESCRIPTIONS[scope]}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
                disabled={busy}
              />
              {scope}
            </label>
          ))}
        </div>
      </section>
      <div
        className="modal-form-actions"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "8px",
          borderTop: "1px solid var(--inner-border)",
          paddingTop: "12px",
        }}
      >
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy || (mode === "create" && !label.trim())} onClick={submit}>
          {busy ? "Saving…" : mode === "create" ? "Create API key" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
