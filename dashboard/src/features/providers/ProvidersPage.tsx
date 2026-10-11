import { ChevronDown, Eye, EyeOff, Plus, Server, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Link, useSearchParams } from "react-router-dom";
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
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ListRow } from "../../components/ui/list-row";
import { Dialog } from "../../components/ui/dialog";
import { DialogActions } from "../../components/ui/dialog-actions";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
const CARD_SHELL = cn(
  "provider-card relative flex flex-col border border-inner-border rounded-card",
  "transition-[transform,border-color,box-shadow]",
);

const CARD_LINK = cn("block flex-1 p-6 no-underline text-inherit");

const CARD_NAME = cn("text-body font-semibold overflow-hidden text-ellipsis whitespace-nowrap");

import type {
  CreateProviderRequest,
  ProviderAccountResponse,
  ProviderResponse,
} from "../../data/contracts";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../../hooks/settings";
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
import { getErrorMessage } from "../../lib/helpers";

const wireFamilies = ["chat", "responses", "messages"] as const;
type WireFamily = (typeof wireFamilies)[number];
type DashboardServiceKind = "llm" | "websearch" | "imageGeneration" | "videoGeneration";



function providerServiceKinds(provider: ProviderResponse): readonly string[] {
  const kinds = provider.serviceKinds;
  return Array.isArray(kinds) && kinds.length > 0 ? kinds : ["llm"];
}


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
      title={isAnthropic ? "Add Custom Anthropic Provider" : "Add Custom [OI] Provider"}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-compatible-provider" disabled={submitting}>
            {submitting ? "Creating..." : "Add Provider"}
          </Button>
        </>
      }
    >
      <form id="add-compatible-provider" onSubmit={submit} className="flex flex-col gap-6">
        {error ? <div className="text-red text-caption">{error}</div> : null}
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
            <div className="flex-1 min-w-0">
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
            <div className="flex-1 min-w-0">
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
              className={cn(
                "mt-3 text-caption leading-[1.4] break-words",
                testResult.ok ? "text-green" : "text-red",
              )}
            >
              {testResult.ok ? "✓ " : "✗ "}
              {testResult.message}
            </div>
          ) : null}
        </div>
        <ListRow className="justify-between">
          <div>
            <div className="text-body font-semibold">Auto-fetch models</div>
            <div className="form-section-caption">
              Discover this provider's model list automatically after creation
            </div>
          </div>
          <Switch checked={autoFetchModels} onChange={setAutoFetchModels} id="compat-autofetch" />
        </ListRow>
        <ListRow className="justify-between">
          <div>
            <div className="text-body font-semibold">
              {isAnthropic ? "Send request as Claude CLI" : "Send request as Codex CLI"}
            </div>
            <div className="form-section-caption">
              {isAnthropic
                ? "Emits official Claude CLI User-Agent and Stainless headers to upstream"
                : "Emits official codex_cli_rs User-Agent and originator headers to upstream"}
            </div>
          </div>
          <Switch checked={sendCliIdentity} onChange={setSendCliIdentity} id="compat-cli-identity" />
        </ListRow>
        <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
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
      className={CARD_SHELL}
    >
      <ProviderVersionBadge clientVersion={customProvider.clientVersion} />
      <Link
        to={`/providers/${encodeURIComponent(customProvider.providerId)}`}
        // See the builtin card: `flex: 1` keeps the clickable area as tall as
        // the stretched card instead of only as tall as the content.
        className={cn(CARD_LINK, "pr-20 min-h-38")}
      >
        <Inline gap="10px">
          <ProviderIcon
            icon={customProvider.wireFamilyDefault === "messages" ? "anthropic" : "openai"}
            name={customProvider.label || customProvider.providerId}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <div
              className={CARD_NAME}
            >
              {customProvider.label || customProvider.providerId}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {accounts === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={accountsQuery.isPending}
                  isError={accountsQuery.isError}
                  hasData={false}
                />
              ) : accounts.length === 0 ? (
                customProvider.requiresAccount === false ? (
                  <Badge tone="ok">Free Endpoint</Badge>
                ) : (
                  <Badge>No connections</Badge>
                )
              ) : (
                <AccountStatusBadges counts={counts} total={accounts.length} />
              )}
              {accountsQuery.isError && accounts !== undefined ? (
                <Badge tone="warn">Connections unavailable</Badge>
              ) : null}

            </div>
          </div>

          <div
            className="flex flex-col items-end gap-1.5 shrink-0"
          >
            <span
              className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg px-2.5 py-0.5 rounded-chip text-text-secondary"
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
        className="absolute top-[4px] right-[4px] p-2 text-text-tertiary"
        title={`Delete ${customProvider.label || customProvider.providerId}`}
      />
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Custom Provider">
        <Stack gap="12px">
          <p className="text-body text-text-secondary">
            Are you sure you want to delete custom provider{" "}
            <strong>{customProvider.label || customProvider.providerId}</strong>? Its models,
            accounts, and routing preferences are deleted together, and requests to this
            provider will no longer route.
          </p>
          {deleteMutation.isError ? (
            <p className="text-caption text-red">
              {getErrorMessage(deleteMutation.error, "Delete failed")}
            </p>
          ) : null}
          <DialogActions>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
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
          </DialogActions>
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
    <section className="flex flex-col gap-5">
      <div
        className="flex items-center justify-between flex-wrap gap-4"
      >
        <button
          type="button"
          onClick={toggleHidden}
          aria-expanded={!hidden}
          title={hidden ? "Show custom providers" : "Hide custom providers"}
          className="inline-flex items-center gap-3 bg-transparent border-none p-0 cursor-pointer text-inherit"
        >
          <h2 className="text-body-lg font-bold tracking-[-0.01em]">
            Custom Providers{customProviders.length > 0 ? ` (${customProviders.length})` : ""}
          </h2>
          <ChevronDown
            size={14}
            className="text-text-tertiary transition-transform"
            style={{ transform: hidden ? "rotate(-90deg)" : undefined }}
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
            className="text-center px-7 py-10 border border-dashed border-inner-border rounded-card"
          >
            <p className="text-body font-semibold text-text-primary">
              No custom providers yet
            </p>
            <p className="text-badge text-text-tertiary mt-1">
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
const WEB_LLM_IDS = new Set(["claude-web", "grok-web", "kimi-web"]);
/**
 * The providers an operator reaches for first: household names with a
 * published API-key signup. Grouped so the long tail of compatible resellers
 * below does not bury the ones everybody has already heard of. `ollama` is
 * registered as `ollamacloud`.
 */
const WELL_KNOWN_API_KEY_IDS = new Set([
  "commandcode",
  "hermes",
  "anthropic",
  "openai",
  "gemini",
  "ollamacloud",
  "opencodezen",
  "opencodego",
  "mistral",
  "meta",
  "deepseek",
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
  serviceKind,
}: {
  provider: ProviderResponse;
  serviceKind?: DashboardServiceKind;
}): ReactNode {
  const isFounding = FOUNDING_IDS.has(provider.providerId.toLowerCase());
  const displayName = provider.label || provider.displayName;
  const modelsQuery = useProviderModels(provider.providerId);
  const modelCount = modelsQuery.data?.filter(
    (model) =>
      serviceKind === undefined ||
      model.serviceKind === serviceKind ||
      (serviceKind === "llm" && model.serviceKind === undefined),
  ).length;
  const accountsQuery = useProviderAccounts(provider.providerId);
  const accounts = accountsQuery.data;
  const counts = summarizeAccounts(accounts ?? []);

  return (
    <Card
      className={CARD_SHELL}
    >
      <ProviderVersionBadge clientVersion={provider.clientVersion} />
      {isFounding ? (
        <span
          aria-label="Friend sponsor"
          title="Friend sponsor"
          className="absolute top-0 right-0 z-2 w-36 h-36 overflow-hidden pointer-events-none"
        >
          <span
            className={cn(
              "absolute top-[18px] right-[-22px] w-38 py-1 rotate-45 bg-accent-soft",
              "text-accent text-micro font-extrabold tracking-[0.04em] leading-[1.05]",
              "text-center uppercase shadow-[0_1px_3px_rgba(0,0,0,0.12)]",
            )}
          >
            Friend
          </span>
        </span>
      ) : null}

      <Link
        to={`/providers/${encodeURIComponent(provider.providerId)}${
          serviceKind === undefined ? "" : `?service=${serviceKind}`
        }`}
        // `flex: 1` is what makes the whole card clickable. Grid rows stretch
        // every card to the tallest one, so a card whose content is shorter
        // than its row left a dead strip below the link — a click there hit
        // the card, not the link, and did nothing.
        className={CARD_LINK}
      >
        <Inline gap="10px">
          <ProviderIcon icon={provider.providerId} name={displayName} size={32} />
          <div className="min-w-0 flex-1">
            <div
              className={CARD_NAME}
            >
              {displayName}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {accounts === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={accountsQuery.isPending}
                  isError={accountsQuery.isError}
                  hasData={false}
                />
              ) : accounts.length === 0 ? (
                provider.requiresAccount === false ? (
                  <Badge tone="ok">Free Endpoint</Badge>
                ) : (
                  <Badge>No connections</Badge>
                )
              ) : (
                <AccountStatusBadges counts={counts} total={accounts.length} />
              )}
              {accountsQuery.isError && accounts !== undefined ? (
                <Badge tone="warn">Connections unavailable</Badge>
              ) : null}
            </div>
          </div>

          <div
            className="flex flex-col items-end gap-1.5 shrink-0"
          >
            <span
              className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg px-2.5 py-0.5 rounded-chip text-text-secondary"
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
const COLLAPSED_SECTIONS_KEY = "cartethyia.providerSectionsCollapsed";

function ForceSearchProvidersToggle(): ReactNode {
  const settings = useRuntimeSettings();
  const update = useUpdateRuntimeSettings();
  return (
    <div className="ml-auto flex items-center gap-4">
      <span className="text-micro font-semibold text-text-tertiary">FORCE ALL SEARCH PROVIDERS</span>
      <Switch
        checked={settings.data?.forceSearchProviders === true}
        disabled={settings.isPending || update.isPending}
        onChange={(checked) => update.mutate({ forceSearchProviders: checked })}
        aria-label="Force all search providers"
      />
    </div>
  );
}

function readCollapsedSections(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

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
    title: "Web Session Providers",
    subtitle: "Signed-in web sessions — no API key",
    filter: (p: ProviderResponse) => WEB_LLM_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "OAuth & Agent Providers",
    // Membership follows the backend registry rather than a hand-kept id list:
    // `oauthFlows` is present on a provider response exactly when the registry
    // resolves a login client for it, so this section cannot drift from the
    // providers that really support a login flow.
    filter: (p: ProviderResponse) =>
      p.oauthFlows !== undefined && !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) && !WEB_LLM_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "Well Known API Key Providers",
    subtitle: "The household names — sign up with a key and go",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      WELL_KNOWN_API_KEY_IDS.has(p.providerId.toLowerCase()) &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      p.oauthFlows === undefined && !WEB_LLM_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "Other API Key Providers",
    subtitle: "Free tier friendly — no credit card",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      !WELL_KNOWN_API_KEY_IDS.has(p.providerId.toLowerCase()) &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      p.oauthFlows === undefined && !WEB_LLM_IDS.has(p.providerId.toLowerCase()),
  },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Providers(): ReactNode {
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(readCollapsedSections);
  const q = useProviders();
  const allProviders = useMemo(() => q.data ?? [], [q.data]);
  const customProviders = useMemo(
    () => [...allProviders.filter((p) => !p.isBuiltIn)].sort(compareConfiguredProviders),
    [allProviders],
  );
  const searchProviders = useMemo(
    () => allProviders.filter((p) => providerServiceKinds(p).includes("websearch")),
    [allProviders],
  );
  const llmProviders = useMemo(
    () => allProviders.filter((p) => providerServiceKinds(p).includes("llm")),
    [allProviders],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: "llm" | "search" | "media" =
    requestedTab === "search" || requestedTab === "media" ? requestedTab : "llm";
  const setTab = (next: "llm" | "search" | "media") => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "llm") params.delete("tab");
      else params.set("tab", next);
      return params;
    });
  };
  const mediaProviders = useMemo(
    () =>
      allProviders.filter(
        (p) =>
          providerServiceKinds(p).includes("imageGeneration") ||
          providerServiceKinds(p).includes("videoGeneration"),
      ),
    [allProviders],
  );
  const orderedSearch = useMemo(
    () => [...searchProviders].sort((a, b) => (a.label || a.displayName).localeCompare(b.label || b.displayName)),
    [searchProviders],
  );
  const sortFn = (a: ProviderResponse, b: ProviderResponse) => {
    const configuredDiff = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
    if (configuredDiff !== 0) return configuredDiff;
    return (a.label || a.displayName).localeCompare(b.label || b.displayName);
  };
  const sections = useMemo(() => {
    if (tab === "media") {
      return [
        {
          title: "Media Generation",
          subtitle: "Providers that can return an image or a video",
          providers: mediaProviders,
        },
      ].filter((s) => s.providers.length > 0);
    }
    if (tab === "search") {
      return [
        {
          title: "Search Providers",
          subtitle: "Providers that can answer a web search request",
          providers: orderedSearch,
        },
      ].filter((s) => s.providers.length > 0);
    }
    const source = llmProviders;
    return SECTIONS.map((section) => ({
      ...section,
      providers: source.filter(section.filter).sort(sortFn),
    })).filter((section) => section.providers.length > 0);
  }, [llmProviders, orderedSearch, mediaProviders, tab]);

  const state = q.isPending && !q.data
    ? <LoadingState label="Loading providers..." />
    : q.isError
      ? (
        <ErrorState
          message={getErrorMessage(q.error, "Failed to load providers")}
          onRetry={() => q.refetch()}
        />
      )
      : null;
  if (state) {
    return (
      <Card>
        <CardHeader title="Providers" icon={<Server size={16} />} />
        <CardBody className="flex flex-1">{state}</CardBody>
      </Card>
    );
  }

  return (
    <Stack gap="24px">
      <Card>
        <CardHeader title="Providers" subtitle="Connected pinned first · A–Z" icon={<Server size={16} />} />
        <CardBody className="flex flex-col gap-8">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex gap-2">
          {(["llm", "search", "media"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-6 py-3 rounded-inset text-caption font-semibold border cursor-pointer",
                tab === t
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-inner-border bg-surface-1 text-text-secondary",
              )}
            >
              {t === "llm" ? "LLM" : t === "search" ? "Search" : "Media"}
              {t === "search"
                ? ` (${searchProviders.length})`
                : t === "media"
                  ? ` (${mediaProviders.length})`
                  : ` (${llmProviders.length})`}
            </button>
          ))}
        </div>
        {tab === "search" ? <ForceSearchProvidersToggle /> : (
          <span className="ml-auto text-micro text-text-tertiary">
            {tab === "media" ? "Image and video generation" : "Connected pinned first · A–Z"}
          </span>
        )}
      </div>
      
      {tab === "llm" ? (
        <CustomProvidersSection customProviders={customProviders} />
      ) : null}

      {sections.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState title="No providers found" message="No providers available." />
          </CardBody>
        </Card>
      ) : (
        sections.map((section) => {
          const collapsed = collapsedSections.has(section.title);
          return (
          <section
            key={section.title}
            className="flex flex-col gap-6"
          >
            <button
              type="button"
              className="flex items-start gap-4 border-0 bg-transparent p-0 text-left text-inherit"
              aria-expanded={!collapsed}
              onClick={() => setCollapsedSections((current) => {
                const next = new Set(current);
                if (next.has(section.title)) next.delete(section.title);
                else next.add(section.title);
                try { window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next])); } catch {}
                return next;
              })}
            >
              <ChevronDown size={15} className={cn("mt-1 shrink-0 transition-transform", collapsed && "-rotate-90")} />
              <Stack gap="1px">
                <h2 className="text-body font-bold tracking-[-0.01em]">
                  {section.title} ({section.providers.length}){collapsed ? " (Hidden)" : ""}
                </h2>
                {!collapsed && section.subtitle ? (
                  <p className="form-section-caption">
                    {section.subtitle}
                  </p>
                ) : null}
              </Stack>
            </button>

            {collapsed ? null : (
            <ProviderCardGrid>
              {section.providers.map((p) => (
                <ProviderCard
                  key={p.providerId}
                  provider={p}
                  serviceKind={
                    tab === "search"
                      ? "websearch"
                      : tab === "media"
                        ? providerServiceKinds(p).includes("imageGeneration")
                          ? "imageGeneration"
                          : "videoGeneration"
                        : "llm"
                  }
                />
              ))}
            </ProviderCardGrid>
            )}
          </section>
          );
        })
      )}
        </CardBody>
      </Card>
    </Stack>
  );
}
