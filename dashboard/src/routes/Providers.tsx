import { ChevronDown, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  HeaderPairsEditor,
  pairsToHeaders,
  type HeaderPair,
} from "../components/HeaderPairsEditor";
import { ProviderIcon } from "../components/ProviderIcon";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Switch } from "../components/ui/switch";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import type { CreateProviderRequest, ProviderResponse } from "../lib/contracts";
import {
  useCreateProvider,
  useCreateProviderAccount,
  useDeleteProvider,
  useProviderAccounts,
  useProviderModels,
  useProviders,
  useSyncProviderModels,
  useTestByokConnection,
} from "../lib/hooks/providers";
import { providerDisplayName } from "../lib/provider-names";
import { getErrorMessage } from "../lib/helpers";

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
  const modelCount = modelsQuery.data?.length ?? 0;
  const accountsQuery = useProviderAccounts(customProvider.providerId);
  const accounts = accountsQuery.data ?? [];
  const activeConnections = accounts.filter((a) => a.status === "active").length;
  const cooldownCount = accounts.filter((a) => a.status === "cooldown").length;
  const degradedCount = accounts.filter((a) => a.status === "degraded").length;
  const disabledCount = accounts.filter((a) => a.status === "disabled").length;
  const exhaustedCount = accounts.filter((a) => a.lastErrorCategory === "quota_exhausted").length;
  // Any non-active account is a connection of some state: the neutral badge
  // only shows when every account is active and healthy.
  return (
    <Card
      style={{
        position: "relative",
        overflow: "hidden",
        border: "1px solid var(--inner-border)",
        borderRadius: "12px",
        transition:
          "transform var(--dur-micro) var(--ease-spring), border-color var(--dur-micro) var(--ease-spring), box-shadow var(--dur-micro) var(--ease-spring)",
      }}
    >
      <Link
        to={`/providers/${encodeURIComponent(customProvider.providerId)}`}
        style={{
          textDecoration: "none",
          color: "inherit",
          display: "block",
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
              {activeConnections > 0 ? (
                <Badge tone="ok" dot>
                  {activeConnections} Connected
                </Badge>
              ) : cooldownCount + degradedCount + disabledCount + exhaustedCount > 0 ? (
                <Badge tone="warn" dot>
                  {cooldownCount + degradedCount + disabledCount + exhaustedCount} Unhealthy
                </Badge>
              ) : (
                <Badge>No connections</Badge>
              )}
              {cooldownCount > 0 ? (
                <Badge tone="warn" dot>
                  {cooldownCount} Cooldown
                </Badge>
              ) : null}
              {degradedCount > 0 ? (
                <Badge tone="warn" dot>
                  {degradedCount} Degraded
                </Badge>
              ) : null}
              {disabledCount > 0 ? (
                <Badge>Disabled</Badge>
              ) : null}
              {exhaustedCount > 0 ? (
                <Badge tone="warn" dot>
                  {exhaustedCount} Exhausted
                </Badge>
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
            {modelCount > 0 ? <Badge tone="info">{modelCount} models</Badge> : null}
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "10px",
          }}
        >
          {customProviders.map((cp) => (
            <CustomProviderCard key={cp.providerId} customProvider={cp} />
          ))}
        </div>
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
/** Free tiers that are metered (a few requests per day) rather than a standing
 * free allowance. They are listed in {@link FREE_AVAILABLE_IDS} too, but get
 * their own section instead of the general free-available one. */
const FREE_LIMITED_IDS = new Set(["siliconflow", "cerebras", "groq", "opencodeft", "opencodezen", "opencodego", "bai", "tokenharbor"]);
const FREE_AVAILABLE_IDS = new Set([
  "qoder",
  "agentrouter",
  "mistral",
  "gemini",
  "openrouter",
  "siliconflow",
  "cb",
  "cbcn",
  "groq",
  "nvidia",
  "hermes",
  "opencodeft",
  "opencodezen",
  "opencodego",
  "tokenharbor",
  "bai",
  "gmi",
  "aihubmix",
  "cloudflare",
]);

const ProviderCard = memo(function ProviderCard({
  provider,
}: {
  provider: ProviderResponse;
}): ReactNode {
  const isFounding = FOUNDING_IDS.has(provider.providerId.toLowerCase());
  const displayName = providerDisplayName(provider.providerId, provider.label);
  const modelsQuery = useProviderModels(provider.providerId);
  const modelCount = modelsQuery.data?.length ?? 0;
  const accountsQuery = useProviderAccounts(provider.providerId);
  const accounts = accountsQuery.data ?? [];
  const activeConnections = accounts.filter((a) => a.status === "active").length;
  const cooldownCount = accounts.filter((a) => a.status === "cooldown").length;
  const degradedCount = accounts.filter((a) => a.status === "degraded").length;
  const exhaustedCount = accounts.filter((a) => a.lastErrorCategory === "quota_exhausted").length;

  return (
    <Card
      style={{
        position: "relative",
        overflow: "hidden",
        border: "1px solid var(--inner-border)",
        borderRadius: "12px",
        transition: "transform var(--dur-micro) var(--ease-spring), border-color var(--dur-micro) var(--ease-spring), box-shadow var(--dur-micro) var(--ease-spring)",
      }}
    >
      {isFounding ? (
        <div
          style={{
            position: "absolute",
            right: "-24px",
            top: "10px",
            transform: "rotate(45deg)",
            background: "var(--accent)",
            color: "var(--accent-foreground)",
            fontSize: "9px",
            fontWeight: 800,
            padding: "2px 24px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            zIndex: 5,
          }}
        >
          Friend
        </div>
      ) : null}

      <Link
        to={`/providers/${encodeURIComponent(provider.providerId)}`}
        style={{
          textDecoration: "none",
          color: "inherit",
          display: "block",
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
              {activeConnections > 0 ? (
                <Badge tone="ok" dot>
                  {activeConnections} Connected
                </Badge>
              ) : cooldownCount + degradedCount + exhaustedCount > 0 ? (
                <Badge tone="warn" dot>
                  {cooldownCount + degradedCount + exhaustedCount} Unhealthy
                </Badge>
              ) : (
                <Badge>No connections</Badge>
              )}
              {cooldownCount > 0 ? (
                <Badge tone="warn" dot>
                  {cooldownCount} Cooldown
                </Badge>
              ) : null}
              {degradedCount > 0 ? (
                <Badge tone="warn" dot>
                  {degradedCount} Degraded
                </Badge>
              ) : null}
              {exhaustedCount > 0 ? (
                <Badge tone="warn" dot>
                  {exhaustedCount} Exhausted
                </Badge>
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
              {provider.providerId}/
            </span>
            {modelCount > 0 ? <Badge tone="info">{modelCount} models</Badge> : null}
          </div>
        </Inline>
      </Link>
    </Card>
  );
});

function compareConfiguredProviders(a: ProviderResponse, b: ProviderResponse): number {
  const configuredRank = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
  if (configuredRank !== 0) return configuredRank;
  return providerDisplayName(a.providerId, a.label).localeCompare(providerDisplayName(b.providerId, b.label));
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
    filter: (p: ProviderResponse) => p.oauthFlows !== undefined,
  },
  {
    title: "Free Available API Key Providers",
    subtitle: "Free tier friendly — no credit card",
    filter: (p: ProviderResponse) =>
      FREE_AVAILABLE_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      p.oauthFlows === undefined,
  },
  {
    title: "API Key Providers",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_AVAILABLE_IDS.has(p.providerId.toLowerCase()) &&
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

  const sections = useMemo(() => {
    return SECTIONS.map((section) => ({
      ...section,
      providers: builtInProviders.filter(section.filter).sort(compareConfiguredProviders),
    })).filter((section) => section.providers.length > 0);
  }, [builtInProviders]);

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

            <div className="provider-grid">
              {section.providers.map((p) => (
                <ProviderCard key={p.providerId} provider={p} />
              ))}
            </div>
          </section>
        ))
      )}
    </Stack>
  );
}
