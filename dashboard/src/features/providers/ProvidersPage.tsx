import { ChevronDown, Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  HeaderPairsEditor,
  pairsToHeaders,
  type HeaderPair,
} from "../../components/HeaderPairsEditor";
import { ProviderCardGrid } from "../../components/ProviderCardGrid";
import { ProviderIcon } from "../../components/ProviderIcon";
import { modelCoolingCount } from "../../components/AccountCooldown";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import type {
  CreateProviderRequest,
  ProviderAccountResponse,
  ProviderResponse,
} from "../../data/contracts";
import {
  useCreateProvider,
  useCreateProviderAccount,
  useDeleteProvider,
  useProviderAccounts,
  useProviderModels,
  useProviders,
  useSyncProviderModels,
  useTestByokConnection,
} from "../../hooks/providers";
import { getErrorMessage } from "../../shared/helpers";

const wireFamilies = ["chat", "responses", "messages"] as const;
type WireFamily = (typeof wireFamilies)[number];

// ── Custom Compatible Provider Modal ──────────────────────────────────────────

function AddCompatibleModal({
  variant,
  open,
  onClose,
}: {
  variant: "openai-compatible" | "anthropic-compatible";
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const create = useCreateProvider();
  const createAccount = useCreateProviderAccount();
  const syncModels = useSyncProviderModels();
  const testConnection = useTestByokConnection();
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [autoFetchModels, setAutoFetchModels] = useState(false);
  const [sendCliIdentity, setSendCliIdentity] = useState(true);
  const [headerPairs, setHeaderPairs] = useState<readonly HeaderPair[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const isAnthropic = variant === "anthropic-compatible";
  const defaultWire: WireFamily = isAnthropic ? "messages" : "chat";
  const [wireFamily, setWireFamily] = useState<WireFamily>(defaultWire);

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setCredential("");
    setWireFamily(defaultWire);
    setBaseUrl("");
    setAutoFetchModels(false);
    setSendCliIdentity(true);
    setHeaderPairs([]);
    setError(null);
    setTestResult(null);
  }, [open]);

  const pasteInto = async (setter: (value: string) => void) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setter(text.trim());
    } catch {
      setError("Clipboard access denied — paste manually instead.");
    }
  };

  const runTest = async () => {
    if (!baseUrl.trim()) {
      setTestResult({ ok: false, message: "Base URL is required to test the connection." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const extraHeaders = pairsToHeaders(headerPairs);
      const result = await testConnection.mutateAsync({
        baseUrl: baseUrl.trim(),
        apiKey: credential.trim(),
        wireFamily,
        cliIdentity: sendCliIdentity,
        ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      });
      if (result.ok) {
        const models =
          typeof result.modelCount === "number" ? ` — upstream advertised ${result.modelCount} model(s)` : "";
        setTestResult({ ok: true, message: `Connected successfully (${result.latencyMs}ms)${models}.` });
      } else {
        setTestResult({
          ok: false,
          message: result.error ?? "Connection failed.",
        });
      }
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Connection test failed") });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("Display Name is required");
      return;
    }
    if (!providerId.trim()) {
      setError("Provider ID (slug) is required");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required");
      return;
    }

    const extraHeaders = pairsToHeaders(headerPairs);
    const id = providerId.trim().toLowerCase();

    setSubmitting(true);
    setError(null);
    try {
      const req: CreateProviderRequest = {
        providerId: id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        wireFamily,
        compatibilityProfile: {
          cli_identity: sendCliIdentity,
          ...(Object.keys(extraHeaders).length > 0 ? { extra_headers: extraHeaders } : {}),
        },
      };
      await create.mutateAsync(req);
      if (credential.trim()) {
        await createAccount.mutateAsync({
          providerId: id,
          request: { credentialKind: "api_key", secret: credential.trim() },
        });
      }
      if (autoFetchModels) {
        await syncModels.mutateAsync(id);
      }
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create provider"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isAnthropic ? "Add Custom Anthropic Provider" : "Add Custom OpenAI Provider"}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {error ? <div style={{ color: "var(--red)", fontSize: "12px" }}>{error}</div> : null}
        <Input
          label="Display Name"
          hint="Required. A friendly label for this node."
          id="compat-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={isAnthropic ? "Anthropic Compatible (Prod)" : "OpenAI Compatible (Prod)"}
          required
        />
        <Input
          label="Provider ID / Slug"
          hint="Required. Used as the provider prefix for model IDs."
          id="compat-slug"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          required
        />
        <div className="form-group">
          <label className="form-label" htmlFor="compat-url">
            <span>Base URL</span>
          </label>
          <Inline gap="8px">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input
                id="compat-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
                }
                required
              />
            </div>
            <Button type="button" variant="secondary" onClick={() => pasteInto(setBaseUrl)}>
              Paste
            </Button>
          </Inline>
        </div>
        {isAnthropic ? null : (
          <Select
            id="compat-wire"
            label="API format"
            value={wireFamily}
            onValueChange={(value) => setWireFamily(value as WireFamily)}
            options={[
              { value: "chat", label: "Chat completions" },
              { value: "responses", label: "Responses" },
            ]}
          />
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="compat-credential">
            <span>API Key</span>
            <span className="form-hint">
              Optional — saved with this provider and used to authenticate every request.
            </span>
          </label>
          <Inline gap="8px">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input
                id="compat-credential"
                type="password"
                placeholder="sk-..."
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={testing}
              onClick={() => void runTest()}
            >
              {testing ? "Testing..." : "Test connection"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => pasteInto(setCredential)}>
              Paste
            </Button>
          </Inline>
          {testResult ? (
            <div
              style={{
                marginTop: "6px",
                fontSize: "12px",
                lineHeight: "1.4",
                color: testResult.ok ? "var(--green, #2f9e44)" : "var(--red)",
                wordBreak: "break-word",
              }}
            >
              {testResult.ok ? "✓ " : "✗ "}
              {testResult.message}
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: "10px",
            border: "1px solid var(--inner-border)",
          }}
        >
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>Auto-fetch models</div>
            <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              Discover this provider's model list automatically after creation
            </div>
          </div>
          <Switch checked={autoFetchModels} onChange={setAutoFetchModels} id="compat-autofetch" />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: "10px",
            border: "1px solid var(--inner-border)",
          }}
        >
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>
              {isAnthropic ? "Send request as Claude CLI" : "Send request as Codex CLI"}
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              {isAnthropic
                ? "Emits official Claude CLI User-Agent and Stainless headers to upstream"
                : "Emits official codex_cli_rs User-Agent and originator headers to upstream"}
            </div>
          </div>
          <Switch checked={sendCliIdentity} onChange={setSendCliIdentity} id="compat-cli-identity" />
        </div>
        <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
        <Inline justify="flex-end" gap="8px" style={{ marginTop: "8px" }}>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Add Provider"}
          </Button>
        </Inline>
      </form>
    </Dialog>
  );
}

// ── Custom Providers Section ──────────────────────────────────────────────────

function CustomProviderCard({ customProvider }: { customProvider: ProviderResponse }): ReactNode {
  const deleteMutation = useDeleteProvider();
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Same data the builtin card reads: connection badges and model counts
  // come from the same hooks. Collectorless custom endpoints never refresh
  // quota, so a stale manufactured error is not rendered: the row shows
  // "No quota data" on its detail page instead of a red herring here.
  const modelsQuery = useProviderModels(customProvider.providerId);
  const modelCount = modelsQuery.data?.length;
  const accountsQuery = useProviderAccounts(customProvider.providerId);
  const accounts = accountsQuery.data;
  const counts = summarizeAccounts(accounts ?? []);
  // Any non-active account is a connection of some state: the neutral badge
  // only shows when every account is active and healthy.
  return (
    <Card
      className="provider-card provider-card-custom"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--inner-border)",
        borderRadius: "12px",
        transition:
          "transform var(--dur-micro) var(--ease-spring), border-color var(--dur-micro) var(--ease-spring), box-shadow var(--dur-micro) var(--ease-spring)",
      }}
    >
      <ProviderVersionBadge clientVersion={customProvider.clientVersion} />
      <Link
        to={`/providers/${encodeURIComponent(customProvider.providerId)}`}
        style={{
          textDecoration: "none",
          color: "inherit",
          // See the builtin card: `flex: 1` keeps the clickable area as tall as
          // the stretched card instead of only as tall as the content.
          display: "block",
          flex: 1,
          padding: "12px",
          paddingRight: "40px",
          minHeight: "76px",
        }}
      >
        <Inline gap="10px">
          <ProviderIcon
            icon={customProvider.wireFamilyDefault === "messages" ? "anthropic" : "openai"}
            name={customProvider.label || customProvider.providerId}
            size={32}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {customProvider.label || customProvider.providerId}
            </div>
            <div style={{ marginTop: "3px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {accounts === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={accountsQuery.isPending}
                  isError={accountsQuery.isError}
                  hasData={false}
                />
              ) : accounts.length === 0 ? (
                <Badge>No connections</Badge>
              ) : (
                <AccountStatusBadges counts={counts} total={accounts.length} />
              )}
              {accountsQuery.isError && accounts !== undefined ? (
                <Badge tone="warn">Connections unavailable</Badge>
              ) : null}

            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "3px",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 600,
                background: "var(--kbd-bg)",
                padding: "1px 5px",
                borderRadius: "4px",
                color: "var(--text-secondary)",
              }}
            >
              {customProvider.providerId}/
            </span>
            {modelCount !== undefined && modelCount > 0 ? (
              <Badge tone="info">{modelCount} models</Badge>
            ) : null}
            {modelsQuery.isError ? (
              <Badge tone="warn">Models unavailable</Badge>
            ) : modelCount === undefined ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={modelsQuery.isPending}
                isError={false}
                hasData={false}
              />
            ) : modelCount === 0 ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData
                isEmpty
              />
            ) : null}
          </div>
        </Inline>
      </Link>
      <Button
        variant="ghost"
        size="sm"
        icon={<Trash2 size={12} />}
        onClick={() => setDeleteOpen(true)}
        style={{
          position: "absolute",
          top: "4px",
          right: "4px",
          color: "var(--text-tertiary)",
          padding: "4px",
        }}
        title={`Delete ${customProvider.label || customProvider.providerId}`}
      />
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Custom Provider">
        <Stack gap="12px">
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Are you sure you want to delete custom provider{" "}
            <strong>{customProvider.label || customProvider.providerId}</strong>? Its models,
            accounts, and routing preferences are deleted together, and requests to this
            provider will no longer route.
          </p>
          {deleteMutation.isError ? (
            <p style={{ fontSize: "12px", color: "var(--red)" }}>
              {getErrorMessage(deleteMutation.error, "Delete failed")}
            </p>
          ) : null}
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              style={{ background: "var(--red)", borderColor: "var(--red)" }}
              onClick={() => {
                deleteMutation.mutate(customProvider.providerId, {
                  onSuccess: () => setDeleteOpen(false),
                  onError: () => undefined,
                });
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Provider"}
            </Button>
          </div>
        </Stack>
      </Dialog>
    </Card>
  );
}

function CustomProvidersSection({
  customProviders,
}: {
  customProviders: ProviderResponse[];
}): ReactNode {
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenAI, setShowOpenAI] = useState(false);
  // Collapsed by operator choice, persisted per browser. Hidden providers
  // stay mounted (badges stay fresh) — only the grid is concealed.
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem("cartethyia.customProvidersHidden") === "1";
    } catch {
      return false;
    }
  });

  function toggleHidden(): void {
    setHidden((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("cartethyia.customProvidersHidden", next ? "1" : "0");
      } catch {
        // Private mode: the toggle still works for this session.
      }
      return next;
    });
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <button
          type="button"
          onClick={toggleHidden}
          aria-expanded={!hidden}
          title={hidden ? "Show custom providers" : "Hide custom providers"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <h2 style={{ fontSize: "14px", fontWeight: 700, letterSpacing: "-0.01em" }}>
            Custom Providers{customProviders.length > 0 ? ` (${customProviders.length})` : ""}
          </h2>
          <ChevronDown
            size={14}
            style={{
              transform: hidden ? "rotate(-90deg)" : undefined,
              transition: "transform var(--dur-micro) var(--ease-spring)",
              color: "var(--text-tertiary)",
            }}
          />
        </button>
        <Inline gap="8px">
          <Button
            size="sm"
            variant="ghost"
            icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            onClick={toggleHidden}
            title={hidden ? "Show custom providers" : "Hide custom providers"}
          >
            {hidden ? "Show" : "Hide"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => setShowAnthropic(true)}
          >
            Custom Anthropic
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => setShowOpenAI(true)}
          >
            Custom OpenAI
          </Button>
        </Inline>
      </div>

      {hidden ? null : customProviders.length === 0 ? (
        <Card>
          <CardBody
            style={{
              textAlign: "center",
              padding: "20px 14px",
              border: "1px dashed var(--inner-border)",
              borderRadius: "12px",
            }}
          >
            <p style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              No custom providers yet
            </p>
            <p style={{ fontSize: "11.5px", color: "var(--text-tertiary)", marginTop: "2px" }}>
              Add an OpenAI- or Anthropic-compatible endpoint with the buttons above.
            </p>
          </CardBody>
        </Card>
      ) : (
        <ProviderCardGrid>
          {customProviders.map((cp) => (
            <CustomProviderCard key={cp.providerId} customProvider={cp} />
          ))}
        </ProviderCardGrid>
      )}

      <AddCompatibleModal
        variant="anthropic-compatible"
        open={showAnthropic}
        onClose={() => setShowAnthropic(false)}
      />
      <AddCompatibleModal
        variant="openai-compatible"
        open={showOpenAI}
        onClose={() => setShowOpenAI(false)}
      />
    </section>
  );
}

// ── Provider Card ─────────────────────────────────────────────────────────────

const FOUNDING_IDS = new Set(["inferhub"]);
/** Free tiers with a small daily allowance rather than a standing free tier. */
const FREE_LIMITED_IDS = new Set([
  "grok",
  "opencodeft",
  "cline",
]);

/**
 * Connection counts for one provider's card.
 *
 * Computed once here because both card variants render the same badges from the
 * same accounts, and keeping two copies is what let the per-model case go
 * missing from the list: an account throttled for one model keeps
 * `status: "active"` (see `account-health-service.ts`), so a rollup built from
 * `status === "cooldown"` alone reported it as a healthy connection while its
 * own detail page said "1 model cooling".
 *
 * `active` and `cooling` are therefore separate counts over the same account,
 * and both are meant to show at once: a cooling account IS connected and
 * routable for its other models, it is just not being routed to for the models
 * named in `modelCooldowns`. The card keeps every status in its own badge so
 * one account is not counted as unhealthy merely because it is cooling or in
 * cooldown.
 */
interface AccountStatusCounts {
  readonly active: number;
  readonly cooldown: number;
  readonly disabled: number;
  readonly cooling: number;
}

function summarizeAccounts(accounts: readonly ProviderAccountResponse[]): AccountStatusCounts {
  return {
    active: accounts.filter((account) => account.status === "active").length,
    cooldown: accounts.filter((account) => account.status === "cooldown").length,
    disabled: accounts.filter((account) => account.status === "disabled").length,
    cooling: modelCoolingCount(accounts),
  };
}

function AccountStatusBadges({
  counts,
  total,
}: {
  readonly counts: AccountStatusCounts;
  readonly total: number;
}): ReactNode {
  const hasBadge =
    counts.active > 0 ||
    counts.cooldown > 0 ||
    counts.cooling > 0 ||
    counts.disabled > 0;
  if (!hasBadge) return <Badge tone="warn" dot>{total} Connected</Badge>;
  return (
    <>
      {counts.active > 0 ? <Badge tone="ok" dot>{counts.active} Healthy</Badge> : null}
      {counts.cooldown > 0 ? <Badge tone="warn" dot>{counts.cooldown} Cooldown</Badge> : null}
      {counts.cooling > 0 ? <Badge tone="warn" dot>{counts.cooling} Cooling</Badge> : null}
      {counts.disabled > 0 ? <Badge tone="warn" dot>{counts.disabled} Unhealthy</Badge> : null}
    </>
  );
}

function SecondaryQueryBadge({
  kind,
  isPending,
  isError,
  hasData,
  isEmpty = false,
}: {
  kind: "models" | "accounts";
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
  isEmpty?: boolean;
}): ReactNode {
  const label = kind === "models" ? "Models" : "Connections";
  if (isError) return <Badge tone="warn">{label} unavailable</Badge>;
  if (isPending && !hasData) return <Badge tone="info">Loading {label.toLowerCase()}…</Badge>;
  if (isEmpty) return <Badge>{kind === "models" ? "No models" : "No connections"}</Badge>;
  return null;
}

function ProviderVersionBadge({
  clientVersion,
}: {
  readonly clientVersion: ProviderResponse["clientVersion"];
}): ReactNode {
  if (!clientVersion) return null;
  return (
    <Badge
      className="provider-version-badge"
      tone={clientVersion.source === "latest" ? "teal" : "default"}
      title={
        clientVersion.source === "latest"
          ? "Latest discovered client version"
          : "Pinned fallback; background discovery has not succeeded yet"
      }
    >
      v{clientVersion.version} · {clientVersion.source}
    </Badge>
  );
}

const ProviderCard = memo(function ProviderCard({
  provider,
}: {
  provider: ProviderResponse;
}): ReactNode {
  const isFounding = FOUNDING_IDS.has(provider.providerId.toLowerCase());
  const displayName = provider.label || provider.displayName;
  const modelsQuery = useProviderModels(provider.providerId);
  const modelCount = modelsQuery.data?.length;
  const accountsQuery = useProviderAccounts(provider.providerId);
  const accounts = accountsQuery.data;
  const counts = summarizeAccounts(accounts ?? []);

  return (
    <Card
      className="provider-card"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--inner-border)",
        borderRadius: "12px",
        transition: "transform var(--dur-micro) var(--ease-spring), border-color var(--dur-micro) var(--ease-spring), box-shadow var(--dur-micro) var(--ease-spring)",
      }}
    >
      <ProviderVersionBadge clientVersion={provider.clientVersion} />

      <Link
        to={`/providers/${encodeURIComponent(provider.providerId)}`}
        style={{
          textDecoration: "none",
          color: "inherit",
          // `flex: 1` is what makes the whole card clickable. Grid rows stretch
          // every card to the tallest one, so a card whose content is shorter
          // than its row left a dead strip below the link — a click there hit
          // the card, not the link, and did nothing.
          display: "block",
          flex: 1,
          padding: "12px",
        }}
      >
        <Inline gap="10px">
          <ProviderIcon icon={provider.providerId} name={displayName} size={32} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </div>
            <div style={{ marginTop: "3px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {accounts === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={accountsQuery.isPending}
                  isError={accountsQuery.isError}
                  hasData={false}
                />
              ) : accounts.length === 0 ? (
                <Badge>No connections</Badge>
              ) : (
                <AccountStatusBadges counts={counts} total={accounts.length} />
              )}
              {accountsQuery.isError && accounts !== undefined ? (
                <Badge tone="warn">Connections unavailable</Badge>
              ) : null}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "3px",
              flexShrink: 0,
            }}
          >
            {isFounding ? <Badge tone="accent">Friend</Badge> : null}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 600,
                background: "var(--kbd-bg)",
                padding: "1px 5px",
                borderRadius: "4px",
                color: "var(--text-secondary)",
              }}
            >
              {provider.providerId}/
            </span>
            {modelCount !== undefined && modelCount > 0 ? (
              <Badge tone="info">{modelCount} models</Badge>
            ) : null}
            {modelsQuery.isError ? (
              <Badge tone="warn">Models unavailable</Badge>
            ) : modelCount === undefined ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={modelsQuery.isPending}
                isError={false}
                hasData={false}
              />
            ) : modelCount === 0 ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData
                isEmpty
              />
            ) : null}
          </div>
        </Inline>
      </Link>
    </Card>
  );
});

function compareConfiguredProviders(a: ProviderResponse, b: ProviderResponse): number {
  const configuredRank = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
  if (configuredRank !== 0) return configuredRank;
  return (a.label || a.displayName).localeCompare(b.label || b.displayName);
}

// ── Sections Definition ───────────────────────────────────────────────────────

const SECTIONS = [
  {
    title: "Founding Friend & Sponsors",
    subtitle: "Super Cheap inference pool",
    filter: (p: ProviderResponse) => FOUNDING_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "Free Limited Providers",
    filter: (p: ProviderResponse) => FREE_LIMITED_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "OAuth & Agent Providers",
    // Membership follows the backend registry rather than a hand-kept id list:
    // `oauthFlows` is present on a provider response exactly when the registry
    // resolves a login client for it, so this section cannot drift from the
    // providers that really support a login flow.
    filter: (p: ProviderResponse) =>
      p.oauthFlows !== undefined && !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "API Key Providers",
    subtitle: "Free tier friendly — no credit card",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      p.oauthFlows === undefined,
  },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Providers(): ReactNode {
  const q = useProviders();
  const allProviders = useMemo(() => q.data ?? [], [q.data]);
  const customProviders = useMemo(
    () => [...allProviders.filter((p) => !p.isBuiltIn)].sort(compareConfiguredProviders),
    [allProviders],
  );
  const builtInProviders = useMemo(() => allProviders.filter((p) => p.isBuiltIn), [allProviders]);
  const searchProviders = useMemo(
    () => builtInProviders.filter((p) => p.providerId === "exa" || p.providerId === "tavily" || p.providerId === "brave"),
    [builtInProviders],
  );
  const llmProviders = useMemo(
    () => builtInProviders.filter((p) => p.providerId !== "exa" && p.providerId !== "tavily" && p.providerId !== "brave"),
    [builtInProviders],
  );
  const [tab, setTab] = useState<"all" | "llm" | "search">("all");
  const [searchOrder, setSearchOrder] = useState<string[] | null>(null);
  useEffect(() => {
    // Seed from server preference; fallback to localStorage for immediate UX before first fetch
    import("../../data/api").then(({ consoleRequest }) =>
      consoleRequest<{ preferences: { webSearchOrder?: string[] } }>("/settings/runtime").then((r)=>{
        const o=r.preferences?.webSearchOrder;
        if(o?.length) setSearchOrder(o as string[]);
        else { try{ const s=localStorage.getItem("cartethyia:search-order"); if(s) setSearchOrder(JSON.parse(s)); }catch{} }
      }).catch(()=>{ try{ const s=localStorage.getItem("cartethyia:search-order"); if(s) setSearchOrder(JSON.parse(s)); }catch{} })
    );
  }, []);
  const persistOrder = (ids: string[]) => {
    setSearchOrder(ids);
    try{ localStorage.setItem("cartethyia:search-order", JSON.stringify(ids)); }catch{}
    import("../../data/api").then(({ consoleRequest }) => consoleRequest("/settings/runtime",{method:"PATCH", body: JSON.stringify({ webSearchOrder: ids })}).catch(()=>{}));
  };
  const orderedSearch = useMemo(() => {
    if (!searchOrder) return [...searchProviders].sort((a,b)=>(a.label||a.displayName).localeCompare(b.label||b.displayName));
    const idx=new Map(searchOrder.map((id,i)=>[id,i] as const));
    return [...searchProviders].sort((a,b)=>(idx.get(a.providerId)??999)-(idx.get(b.providerId)??999));
  }, [searchProviders, searchOrder]);
  const sortFn = (a: ProviderResponse, b: ProviderResponse) => {
    const configuredDiff = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
    if (configuredDiff !== 0) return configuredDiff;
    return (a.label || a.displayName).localeCompare(b.label || b.displayName);
  };
  const sections = useMemo(() => {
    if (tab === "search") {
      return [
        {
          title: "Search Providers",
          subtitle: "Drag to reorder — top is tried first on POST /v1/search",
          providers: orderedSearch,
        },
      ].filter((s) => s.providers.length > 0);
    }
    const source = tab === "llm" ? llmProviders : builtInProviders;
    return SECTIONS.map((section) => ({
      ...section,
      providers: source.filter(section.filter).sort(sortFn),
    })).filter((section) => section.providers.length > 0);
  }, [builtInProviders, llmProviders, orderedSearch, tab]);

  if (q.isPending && !q.data) return <LoadingState label="Loading providers..." />;
  if (q.isError)
    return (
      <ErrorState
        message={getErrorMessage(q.error, "Failed to load providers")}
        onRetry={() => q.refetch()}
      />
    );

  return (
    <Stack gap="24px">
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "4px" }}>
          {(["all", "llm", "search"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 600,
                border: tab === t ? "1px solid var(--accent)" : "1px solid var(--inner-border)",
                background: tab === t ? "var(--accent-soft)" : "var(--surface-1)",
                color: tab === t ? "var(--accent)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              {t === "all" ? "All" : t === "llm" ? "LLM" : "Search"}
              {t === "search" ? ` (${searchProviders.length})` : t === "llm" ? ` (${llmProviders.length})` : ""}
            </button>
          ))}
        </div>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "10.5px",
            color: "var(--text-tertiary)",
          }}
        >
          {tab === "search" ? "Drag to reorder" : "Connected pinned first · A–Z"}
        </span>
      </div>
      
      <CustomProvidersSection customProviders={customProviders} />

      {sections.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState title="No providers found" message="No providers available." />
          </CardBody>
        </Card>
      ) : (
        sections.map((section) => (
          <section
            key={section.title}
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <Stack gap="1px">
              <h2 style={{ fontSize: "13.5px", fontWeight: 700, letterSpacing: "-0.01em" }}>
                {section.title} ({section.providers.length})
              </h2>
              {section.subtitle ? (
                <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  {section.subtitle}
                </p>
              ) : null}
            </Stack>

            {tab === "search" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {section.providers.map((p, idx) => (
                  <div
                    key={p.providerId}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", p.providerId); e.dataTransfer.effectAllowed="move"; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from=e.dataTransfer.getData("text/plain");
                      if(!from || from===p.providerId) return;
                      const ids=orderedSearch.map(x=>x.providerId);
                      const a=ids.indexOf(from), b=ids.indexOf(p.providerId);
                      if(a<0||b<0) return;
                      ids.splice(a,1); ids.splice(b,0,from);
                      persistOrder(ids);
                    }}
                    style={{ display:"flex", alignItems:"stretch", gap:"6px" }}
                  >
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"2px", paddingTop:"8px" }}>
                      <GripVertical size={14} style={{ color:"var(--text-tertiary)", cursor:"grab" }} />
                      <span style={{ fontSize:"10px", color:"var(--text-tertiary)", fontWeight:700 }}>{idx+1}</span>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}><ProviderCard provider={p} /></div>
                  </div>
                ))}
              </div>
            ) : (
              <ProviderCardGrid>
                {section.providers.map((p) => (
                  <ProviderCard key={p.providerId} provider={p} />
                ))}
              </ProviderCardGrid>
            )}
          </section>
        ))
      )}
    </Stack>
  );
}
