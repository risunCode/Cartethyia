import {
  Boxes,
  Cable,
  Download,
  ExternalLink,
  KeyRound,
  LockOpen,
  PackageX,
  Plus,
  PowerOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { consoleRequest } from "../data/api";
import { ProviderIcon } from "../components/ProviderIcon";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { BackLink, PageHeader } from "../components/ui/page-header";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog } from "../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import {
  useProbeAllProviderAccounts,
  useProviderAccounts,
  useProviderModels,
  useProviders,
  useStartOAuthAuthorize,
  useSyncProviderModels,
  useUpdateGlobalProvider,
} from "../hooks/providers";
import { queryKeys } from "../data/query-keys";
import { toast } from "../shared/toast";
import type { ProviderAccountResponse } from "../data/contracts";
import { providerCanConfigureUserAgent } from "../shared/provider-user-agent";
import { RoutingStrategyCard } from "./provider-detail/RoutingStrategyCard";
import { CredentialNotice } from "./provider-detail/CredentialNotice";
import { AccountsList, AddAccountModal } from "./provider-detail/Accounts";
import { CreditPoolCard } from "./provider-detail/CreditPool";
import { DeviceCodeDialog, OAuthBrowserDialog } from "./provider-detail/OAuthDialogs";
import {
  ImportCredentialDialog,
  LoginFieldsForm,
  initialFieldValues,
  missingRequiredFields,
} from "./provider-detail/ImportCredentialDialog";
import { AddModelModal, ModelGrid, ThinkingSelect } from "./provider-detail/Models";
import type { ProbeReasoningEffort } from "../data/contracts";

export default function ProviderDetail(): ReactNode {
  const { providerId } = useParams<{ providerId: string }>();
  const id = providerId ?? "";
  const providersQuery = useProviders();
  const modelsQuery = useProviderModels(id);
  const accountsQuery = useProviderAccounts(id);
  const syncModels = useSyncProviderModels();
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const probeAllAccounts = useProbeAllProviderAccounts();
  const updateGlobalProvider = useUpdateGlobalProvider();
  const startAuthorize = useStartOAuthAuthorize();
  const queryClient = useQueryClient();
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  // Section-wide reasoning effort for every test in the Models card. Defaults to
  // `auto` — the probe sends no reasoning intent, because whether the model
  // supports reasoning is often exactly what the test is trying to find out.
  const [thinkingEffort, setThinkingEffort] = useState<ProbeReasoningEffort>("auto");
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  // Which flow is collecting its declared fields before it starts. `null` means
  // no prompt is open. A flow whose provider declares no fields starts directly.
  const [flowPrompt, setFlowPrompt] = useState<"browser" | "device" | null>(null);
  const [flowValues, setFlowValues] = useState<Record<string, string>>({});
  const [deviceParameters, setDeviceParameters] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<ProviderAccountResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [oauthBrowserSession, setOauthBrowserSession] = useState<{
    authorizeUrl: string;
    state: string;
    popup: Window;
  } | null>(null);
  // Tracks the OAuth popup outside React state so it can be closed on
  // authorize error or component unmount even if the session never sets.
  const oauthPopupRef = useRef<Window | null>(null);

  useEffect(
    () => () => {
      const popup = oauthPopupRef.current;
      oauthPopupRef.current = null;
      if (popup && !popup.closed) popup.close();
    },
    [],
  );

  const provider = (providersQuery.data ?? []).find((item) => item.providerId === id);
  const accounts = accountsQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  // and sort alphabetically so enable/disable doesn't jump the layout.
  const deduped = (() => {
    const seen = new Map<string, (typeof models)[number]>();
    for (const m of models) {
      const existing = seen.get(m.modelId);
      if (!existing) seen.set(m.modelId, m);
      else {
        // Prefer the one with larger context (builtin over discovered)
        const existingCtx = existing.contextLimit ?? 0;
        const nextCtx = m.contextLimit ?? 0;
        if (nextCtx > existingCtx) seen.set(m.modelId, m);
      }
    }
    return [...seen.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  })();
  const stableModels = deduped;

  if (providersQuery.isPending) return <LoadingState label="Loading provider..." />;
  // A failed catalog load is NOT a missing provider. Without this branch a 500
  // rendered "Provider not found", which sends the operator looking for a
  // deleted provider instead of at the outage in front of them.
  if (providersQuery.isError)
    return (
      <ErrorState
        title="Unable to load providers"
        message="The provider catalog could not be read, so this page cannot resolve its provider."
        onRetry={() => void providersQuery.refetch()}
        retrying={providersQuery.isFetching}
        action={<BackLink to="/providers" label="Back to providers" />}
      />
    );
  if (!provider)
    return (
      <EmptyState
        icon={<PackageX size={20} />}
        title="Provider not found"
        message={`No provider named “${id}”. It may have been removed, or the link is stale.`}
        action={<BackLink to="/providers" label="Back to providers" />}
      />
    );

  const activeAccounts = accounts.filter((a) => a.status === "active").length;

  /**
   * Starts a flow, collecting its declared fields first when it has any.
   *
   * The provider declares which values it needs and whether they are required,
   * so a flow with nothing to ask starts on the click and one with a question
   * opens the prompt instead of failing server-side for a missing value.
   */
  const beginFlow = (flow: "browser" | "device") => {
    const fields =
      flow === "browser"
        ? (provider?.oauthFlows?.browserLoginFields ?? [])
        : (provider?.oauthFlows?.deviceLoginFields ?? []);
    if (fields.length === 0) {
      if (flow === "browser") handleOAuthBrowser();
      else setDeviceDialogOpen(true);
      return;
    }
    setFlowValues(initialFieldValues(fields));
    setFlowPrompt(flow);
  };

  /** Confirms the open prompt, then starts the flow it was collecting for. */
  const submitFlowPrompt = () => {
    if (flowPrompt === null) return;
    const fields =
      flowPrompt === "browser"
        ? (provider?.oauthFlows?.browserLoginFields ?? [])
        : (provider?.oauthFlows?.deviceLoginFields ?? []);
    const missing = missingRequiredFields(fields, flowValues);
    if (missing.length > 0) {
      toast.error("Missing required fields", `Fill in: ${missing.join(", ")}`);
      return;
    }
    const flow = flowPrompt;
    setFlowPrompt(null);
    if (flow === "browser") handleOAuthBrowser(flowValues);
    else {
      setDeviceParameters(flowValues);
      setDeviceDialogOpen(true);
    }
  };

  const handleOAuthBrowser = (parameters?: Record<string, string>) => {
    // Opened synchronously in the click handler so popup blockers allow it.
    // `opener` is severed (noopener equivalent) while retaining the handle
    // needed to navigate/close the window; `window.open` with a literal
    // `noopener` feature would return null instead.
    const blankPopup = window.open("about:blank", "cartethyia-oauth", "popup,width=720,height=820");
    if (blankPopup) {
      blankPopup.opener = null;
      oauthPopupRef.current = blankPopup;
    }
    startAuthorize.mutate(
      { providerId: id, ...(parameters === undefined ? {} : { parameters }) },
      {
        onSuccess: ({ authorizeUrl, state }) => {
          let target: Window | null = null;
          if (blankPopup && !blankPopup.closed) {
            blankPopup.location.href = authorizeUrl;
            target = blankPopup;
          } else {
            target = window.open(authorizeUrl, "cartethyia-oauth", "popup,width=720,height=820");
            if (target) {
              target.opener = null;
              oauthPopupRef.current = target;
            }
          }
          if (!target) {
            toast.error("Popup blocked", "Allow popups to complete OAuth login.");
            return;
          }
          setOauthBrowserSession({ authorizeUrl, state, popup: target });
        },
        onError: (err) => {
          if (blankPopup && !blankPopup.closed) blankPopup.close();
          if (oauthPopupRef.current === blankPopup) oauthPopupRef.current = null;
          toast.error(
            "Failed to start OAuth",
            (err as { message?: string }).message ?? "Unable to start authorization",
          );
        },
      },
    );
  };
  const closeOAuthBrowserSession = (completed: boolean) => {
    oauthPopupRef.current = null;
    setOauthBrowserSession(null);
    if (completed) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) });
    }
  };
  const runGrokAccountProbe = () => {
    probeAllAccounts.mutate(
      {
        providerId: id,
        request: {
          modelId: "grok-4.6",
          wireFamily: "responses",
          prompt: "Reply with exactly: 407",
          reasoningEffort: "high",
          maxOutputTokens: 1024,
          stream: true,
        },
      },
      {
        onSuccess: (result) => {
          const ok = result.results.filter((entry) => entry.ok).length;
          const rateLimited = result.results.filter((entry) => entry.statusCode === 202).length;
          const failed = result.results.length - ok - rateLimited;
          toast.success(
            "Grok account probe complete",
            `${ok} passed · ${rateLimited} returned 202 and were parked in cooldown · ${failed} other failures`,
          );
        },
        onError: (error) =>
          toast.error(
            "Grok account probe failed",
            (error as { message?: string }).message ?? "Unable to probe Grok accounts",
          ),
      },
    );
  };
  return (
    <Stack gap="16px">
      <PageHeader
        title={(provider.label || provider.displayName)}
        description={`${provider.providerId}/${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`}
        icon={
          <ProviderIcon
            icon={provider.providerId}
            name={(provider.label || provider.displayName)}
            size={28}
          />
        }
        back={{ to: "/providers", label: "Back to Providers" }}
        actions={
          <Inline gap="8px" style={{ flexWrap: "wrap", width: "100%", maxWidth: "100%", minWidth: 0 }}>
            {provider.isBuiltIn ? (
              <Button
                variant={provider.enabled ? "danger" : "secondary"}
                icon={provider.enabled ? <PowerOff size={13} /> : <LockOpen size={13} />}
                loading={updateGlobalProvider.isPending}
                onClick={() =>
                  updateGlobalProvider.mutate(
                    { providerId: id, enabled: !provider.enabled },
                    {
                      onSuccess: (updated) =>
                        toast.success(
                          updated.enabled ? "Provider enabled" : "Provider disabled",
                          (provider.label || provider.displayName),
                        ),
                      onError: (err) =>
                        toast.error(
                          "Provider update failed",
                          (err as { message?: string }).message ??
                            "Unable to change provider availability",
                        ),
                    },
                  )
                }
                title={provider.enabled ? "Disable provider globally" : "Enable provider globally"}
              >
                {provider.enabled ? "Disable" : "Enable"}
              </Button>
            ) : null}
          </Inline>
        }

      />
      {/* Where to obtain this provider's credential */}
      <CredentialNotice provider={provider} />
      {/* Routing Strategy */}
      <RoutingStrategyCard
        providerId={id}
        showUserAgent={providerCanConfigureUserAgent(provider)}
      />
      {/* Accounts */}
      {provider.requiresAccount === false ? (
        <Card>
          <CardHeader title="Accounts" icon={<Cable size={16} />} />
          <CardBody>
            <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              This provider is a public, unauthenticated route — no account or credential is
              needed. Routing already works without any setup here.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Accounts"
            subtitle={`${accounts.length} total · ${activeAccounts} active · ${accounts.length - activeAccounts} disabled`}
            icon={<Cable size={16} />}
            action={
              <Inline gap="6px" style={{ flexWrap: "wrap" }}>
                {provider.oauthFlows?.browser && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ExternalLink size={13} />}
                    disabled={startAuthorize.isPending}
                    onClick={() => beginFlow("browser")}
                    title="Browser OAuth login — opens the provider authorize page in a popup"
                  >
                    {startAuthorize.isPending ? "Starting..." : "Login with browser"}
                  </Button>
                )}
                {provider.oauthFlows?.device && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<KeyRound size={13} />}
                    onClick={() => beginFlow("device")}
                    title="Device-code login — enter the shown code on the provider site"
                  >
                    Login with device code
                  </Button>
                )}
                {provider.oauthFlows?.import && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download size={13} />}
                    onClick={() => setImportDialogOpen(true)}
                    title="Import a credential you already hold — a refresh token, an exported auth blob, or an API key"
                  >
                    Import credential
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus size={13} />}
                  onClick={() => setAddAccountOpen(true)}
                >
                  Add Account
                </Button>
              </Inline>
            }
          />
          <CardBody style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <CreditPoolCard providerId={id} />
            {accountsQuery.isPending ? (
              <LoadingState label="Loading accounts..." />
            ) : accountsQuery.isError ? (
              <ErrorState
                message="Failed to load accounts"
                onRetry={() => accountsQuery.refetch()}
              />
            ) : accounts.length === 0 ? (
              <EmptyState
                title="No accounts connected"
                message="Add an API key or OAuth credential to route requests to this provider."
              />
            ) : (
              <AccountsList
                providerId={id}
                accounts={accounts}
                onDelete={(acc) => setDeleteTarget(acc)}
                showGrokProbe={id === "grok"}
                grokProbePending={probeAllAccounts.isPending}
                onGrokProbe={runGrokAccountProbe}
              />
            )}
          </CardBody>
        </Card>
      )}

      {/* Models */}
      <Card>
        <CardHeader
          title="Models"
          subtitle={`${models.length} model${models.length === 1 ? "" : "s"} registered`}
          icon={<Boxes size={16} />}
          action={
            <Inline gap="6px" style={{ flexWrap: "wrap", alignItems: "center" }}>
              <ThinkingSelect
                id="models-section-thinking-effort"
                value={thinkingEffort}
                onChange={setThinkingEffort}
              />
              {provider?.supportsModelDiscovery !== false ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={
                    <RefreshCw size={13} className={syncModels.isPending ? "animate-spin" : ""} />
                  }
                  disabled={syncModels.isPending}
                  onClick={() => syncModels.mutate(id)}
                >
                  {syncModels.isPending ? "Fetching..." : "Fetch models"}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                icon={<Trash2 size={13} className={bulkDeleting ? "animate-spin" : ""} />}
                disabled={
                  syncModels.isPending ||
                  bulkDeleting ||
                  models.filter((m) => m.source !== "builtin" && m.source !== null).length === 0
                }
                onClick={async () => {
                  const fetched = models.filter((m) => m.source !== "builtin" && m.source !== null);
                  if (fetched.length === 0) return;
                  if (!confirm(`Delete ${fetched.length} fetched/manual model(s) for ${id}?`)) return;
                  setBulkDeleting(true);
                  try {
                    const result = await consoleRequest<{
                      deleted: number;
                      total: number;
                      failures: { modelId: string; route: string; code: string; message: string }[];
                    }>(`/providers/${encodeURIComponent(id)}/models/bulk`, {
                      method: "DELETE",
                      body: JSON.stringify({
                        items: fetched.map((m) => ({ modelId: m.modelId, route: m.route })),
                      }),
                    });
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: queryKeys.providers.models(id) }),
                      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
                    ]);
                    const failed = result.failures.length;
                    toast.success(
                      "Fetched models deleted",
                      failed > 0
                        ? `${result.deleted}/${result.total} removed, ${failed} failed`
                        : `${result.deleted}/${result.total} removed`,
                    );
                  } catch (err) {
                    toast.error(
                      "Failed to delete fetched models",
                      (err as { message?: string }).message ?? "Unable to delete models",
                    );
                  } finally {
                    setBulkDeleting(false);
                  }
                }}
              >
                {bulkDeleting ? "Deleting…" : "Delete fetched"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setAddModelOpen(true)}
              >
                Add Model
              </Button>
            </Inline>
          }
        />
        <CardBody style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {modelsQuery.isPending ? (
            <LoadingState label="Loading models..." />
          ) : modelsQuery.isError ? (
            <ErrorState message="Failed to load models" onRetry={() => modelsQuery.refetch()} />
          ) : models.length === 0 ? (
            <EmptyState
              title="No models found"
              message="No models published by this provider yet. Sync or add a custom model above."
            />
          ) : (
            <ModelGrid providerId={id} models={stableModels} thinkingEffort={thinkingEffort} />
          )}
        </CardBody>
      </Card>

      {addAccountOpen && (
        <AddAccountModal
          providerId={id}
          accounts={accounts}
          onClose={() => setAddAccountOpen(false)}
        />
      )}
      {addModelOpen && (
        <AddModelModal providerId={id} provider={provider} onClose={() => setAddModelOpen(false)} />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!isDeleting) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            // Same split as the bulk path: shared accounts are global-admin
            // only, because the tenant-scoped route filters on a tenant id
            // they do not have.
            const path =
              deleteTarget.tenantId === null
                ? `/global/accounts/${encodeURIComponent(deleteTarget.id)}`
                : `/accounts/${encodeURIComponent(deleteTarget.id)}`;
            await consoleRequest(path, {
              method: "DELETE",
            });
            queryClient.removeQueries({
              queryKey: queryKeys.quota.account(deleteTarget.id),
              exact: true,
            });
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) }),
              queryClient.invalidateQueries({
                queryKey: queryKeys.providers.healthEvents(id, deleteTarget.id),
              }),
              queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
              queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
            ]);
            toast.success(
              "Account deleted",
              deleteTarget.label || deleteTarget.id.slice(0, 8),
            );
            setDeleteTarget(null);
          } catch (err) {
            toast.error(
              "Failed to delete account",
              (err as { message?: string }).message ?? "Unable to delete account",
            );
            throw err;
          } finally {
            setIsDeleting(false);
          }
        }}
        title="Delete account?"
        message={`Delete "${deleteTarget?.label || deleteTarget?.id.slice(0, 8)}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
      {deviceDialogOpen && (
        <DeviceCodeDialog
          providerId={id}
          parameters={deviceParameters}
          onClose={() => {
            setDeviceDialogOpen(false);
            setDeviceParameters({});
          }}
        />
      )}
      {flowPrompt !== null && (
        <Dialog
          open={true}
          onClose={() => setFlowPrompt(null)}
          title={flowPrompt === "browser" ? "Sign in with" : "Device sign-in details"}
          width={420}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setFlowPrompt(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={submitFlowPrompt}>
                Continue
              </Button>
            </>
          }
        >
          <Stack gap="12px">
            <p className="oauth-hint">
              {flowPrompt === "browser"
                ? `Choose how ${(provider.label || provider.displayName)} should identify you, then continue to its sign-in page.`
                : "These decide which organization the device code is issued for."}
            </p>
            <LoginFieldsForm
              fields={
                flowPrompt === "browser"
                  ? (provider?.oauthFlows?.browserLoginFields ?? [])
                  : (provider?.oauthFlows?.deviceLoginFields ?? [])
              }
              values={flowValues}
              idPrefix={`flow-${flowPrompt}`}
              onChange={(key, value) => setFlowValues((prev) => ({ ...prev, [key]: value }))}
            />
          </Stack>
        </Dialog>
      )}
      {importDialogOpen && provider?.oauthFlows?.import === true && (
        <ImportCredentialDialog
          providerId={id}
          providerName={(provider.label || provider.displayName)}
          fields={provider.oauthFlows.importFields}
          onClose={() => setImportDialogOpen(false)}
        />
      )}
      {oauthBrowserSession && (
        <OAuthBrowserDialog
          providerId={id}
          authorizeUrl={oauthBrowserSession.authorizeUrl}
          state={oauthBrowserSession.state}
          popup={oauthBrowserSession.popup}
          onClose={closeOAuthBrowserSession}
        />
      )}
    </Stack>
  );
}
