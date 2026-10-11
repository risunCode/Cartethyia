import { ArrowLeft, BookOpen, CheckCircle2, Download, FileCode2, Route, Search, Settings2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { ModelPickerModal } from "../../components/ModelPicker";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { downloadTextFile } from "../../lib/download";
import { toast } from "../../lib/toast";
import { useApiKeys, useUpdateApiKey } from "../../hooks/api-keys";
import {
  useDownloadTool,
  useResetToolMappings,
  useSaveToolMappings,
  useToolMappings,
  useToolRegistry,
  useToolStatuses,
} from "../../hooks/cli-tools";
import type { ApiKeyResponse, ApplyInput, CliMappingInput, ToolRegistryEntry, ToolStatus } from "../../data/contracts";
import { ToolIcon } from "./icons/ToolIcon";
import { getErrorMessage } from "../../lib/helpers";
import { isModelAllowed } from "../../../../src/security/model-access-rule";
import type { ApiKeyModelAccessMode } from "../../../../src/persistence/schema";

export default function CliToolDetail(): ReactNode {
  const { toolId } = useParams();
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();
  const apiKeysQuery = useApiKeys();

  const tool = useMemo(
    () => registryQuery.data?.find((entry) => entry.id === toolId) ?? null,
    [registryQuery.data, toolId],
  );

  const status = useMemo(() => {
    const data = statusesQuery.data as Record<string, ToolStatus> | ToolStatus[] | undefined;
    if (!data) return undefined;
    if (Array.isArray(data))
      return (data as ToolStatus[]).find((s) => (s as { toolId?: string }).toolId === toolId) as
        ToolStatus | undefined;
    return (data as Record<string, ToolStatus>)[toolId as string];
  }, [statusesQuery.data, toolId]);

  if (registryQuery.isLoading) return <LoadingState label="Loading tool details…" />;
  if (registryQuery.isError) {
    return (
      <ErrorState
        title="Unable to load tool"
        message={registryQuery.error?.message ?? "Could not load the CLI tool registry."}
        onRetry={() => void registryQuery.refetch()}
      />
    );
  }
  if (!tool) {
    return (
      <Stack gap="12px">
        <Link to="/cli-tools" className="text-caption text-accent">
          ← Back to CLI Tools
        </Link>
        <ErrorState title="Tool not found" message="Unknown CLI tool id." />
      </Stack>
    );
  }
  return <CliToolDetailBody tool={tool} status={status} apiKeys={apiKeysQuery.data ?? []} />;
}

function CliToolDetailBody({
  tool,
  status,
  apiKeys,
}: {
  tool: ToolRegistryEntry;
  status:
    | {
        installed: boolean;
        configured: boolean;
        settingsPath: string | null;
        currentEndpoint: string | null;
        currentApiKeyPrefix: string | null;
        currentModels: readonly string[] | null;
        message?: string;
      }
    | undefined;
  apiKeys: readonly ApiKeyResponse[];
}): ReactNode {
  // User MUST manually select the API key — no auto-select.
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [endpoint, setEndpoint] = useState(() =>
    typeof window === "undefined" ? "http://localhost:12800" : window.location.origin,
  );
  const [slotModels, setSlotModels] = useState<Record<string, string>>({});
  const [mappingEnabled, setMappingEnabled] = useState(false);
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<"slot" | "target">("slot");

  // Track the last-saved mapping state to avoid re-saving unchanged data.
  const lastSavedRef = useRef<string | null>(null);

  // One dropdown picks the credential *and* the mapping profile: a personal key
  // carries a recoverable secret, a share template has none but owns the routes
  // every child key inherits.
  const selectableKeys = useMemo(
    () =>
      apiKeys.filter(
        (key) => key.keyMode === "personal" || (key.keyMode === "share" && key.parentKeyId === undefined),
      ),
    [apiKeys],
  );

  // Mappings are per-(tool, key): reload whenever the user picks a different key.
  const mappingsQuery = useToolMappings(tool.id, selectedKeyId);
  const saveMappings = useSaveToolMappings();
  const resetMappings = useResetToolMappings();
  const updateApiKey = useUpdateApiKey();
  const downloadTool = useDownloadTool();

  const selectedKey = selectableKeys.find((key) => key.id === selectedKeyId);
  const cliEligible = selectedKey?.scopes?.includes("routing:cli_mapping") === true;
  // Only a personal key can supply the secret written into a CLI config.
  const canAct = selectedKey?.keyMode === "personal";

  // The selected key's model-access policy, evaluated locally so a mapping that
  // the key may not reach is flagged before it silently 404s at request time.
  // `modelRejectionReason` (via `isModelAllowed`) is the exact rule the gateway
  // enforces, imported from the shared pure module — a preview can never
  // disagree with enforcement.
  const accessMode: ApiKeyModelAccessMode = selectedKey?.modelAccessMode ?? "whitelist";
  const accessList = selectedKey?.modelList;
  const modelAllowed = (name: string): boolean =>
    isModelAllowed({ model_access_mode: accessMode, model_list: accessList }, name);

  /** Aliases whose resolved target the selected key may not use. */
  const blockedMappings = useMemo(() => {
    const out = new Set<string>();
    if (!tool.mappingSupported) return out;
    for (const model of tool.defaultModels) {
      const target = mappingTargets[model.alias] ?? "";
      if (target.length === 0) continue;
      // The caller asks for the source name, so authorization is judged on both
      // the requested (source) and the resolved (target) name, as dispatch does.
      const source = slotModels[model.alias] ?? model.defaultValue ?? model.id;
      if (!modelAllowed(target) && !modelAllowed(source)) out.add(model.alias);
    }
    return out;
    // `modelAllowed` closes over `selectedKey`, so the key's identity is the
    // stable dependency; the list itself is re-read from it on each run.
  }, [tool.defaultModels, tool.mappingSupported, mappingTargets, slotModels, selectedKey]);

  // One-click repair: allow the model on the key (append in whitelist mode,
  // remove in blacklist mode) so the operator need not leave for the API-key
  // page. The write goes through the same PATCH the key editor uses.
  const allowModelForKey = (target: string) => {
    if (!selectedKey) return;
    const current = accessList ?? [];
    const next =
      accessMode === "blacklist"
        ? current.filter((entry) => entry !== target)
        : [...new Set([...current, target])];
    updateApiKey.mutate(
      { keyId: selectedKey.id, request: { modelAccessMode: accessMode, modelList: next } },
      {
        onSuccess: () =>
          toast.success(
            accessMode === "blacklist" ? "Model unblocked for this key" : "Model allowed for this key",
          ),
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the API key.")),
      },
    );
  };

  useEffect(() => {
    // When switching tool or key: reset local draft to tool defaults.
    const defaults = Object.fromEntries(
      tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
    );
    setSlotModels(defaults);
    setMappingTargets({});
    lastSavedRef.current = null;
  }, [tool, selectedKeyId]);

  useEffect(() => {
    const settings = mappingsQuery.data;
    if (!settings || settings.apiKeyId !== selectedKeyId) return;
    setMappingEnabled(settings.enabled);
    if (settings.mappings.length > 0) {
      setSlotModels((prev) => ({
        ...prev,
        ...Object.fromEntries(settings.mappings.map((row) => [row.slotKey, row.sourceModel])),
      }));
      setMappingTargets((prev) => ({
        ...prev,
        ...Object.fromEntries(settings.mappings.map((row) => [row.slotKey, row.targetModel])),
      }));
    } else {
      const defaults = Object.fromEntries(
        tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
      );
      setSlotModels(defaults);
      setMappingTargets({});
    }
    lastSavedRef.current = JSON.stringify({ enabled: settings.enabled, mappings: settings.mappings });
  }, [selectedKeyId, mappingsQuery.data, tool.defaultModels]);

  const installed = status?.installed ?? false;
  const configured = status?.configured ?? false;
  const isGuide = tool.configType === "guide";

  const activeModels = useMemo(
    () =>
      tool.defaultModels.map((model) => slotModels[model.alias] ?? model.defaultValue ?? model.id),
    [slotModels, tool.defaultModels],
  );

  const buildMappingInput = useCallback((): CliMappingInput | undefined => {
    if (!tool.mappingSupported) return undefined;
    // The route rows are sent even while Remote Routing is off: the snapshot
    // gates on the enabled flag, so keeping them lets the operator flip the
    // switch back on and find the routes intact. Only the explicit Reset
    // action clears them.
    return {
      enabled: mappingEnabled,
      mappings: tool.defaultModels
        .filter((model) => (mappingTargets[model.alias] ?? "").length > 0)
        .map((model) => ({
          slotKey: model.alias,
          sourceModel: slotModels[model.alias] ?? model.defaultValue ?? model.id,
          targetModel: mappingTargets[model.alias] ?? "",
          enabled: true,
        }))
        .filter((row) => row.targetModel.length > 0),
    };
  }, [mappingEnabled, mappingTargets, slotModels, tool.defaultModels, tool.mappingSupported]);

  // Auto-save mappings against the selected key: a personal key's own bucket, or
  // the share template whose children inherit it.
  useEffect(() => {
    if (!tool.mappingSupported || selectedKeyId.length === 0) return;
    const server = mappingsQuery.data;
    if (!server || server.apiKeyId !== selectedKeyId) return;
    const input = buildMappingInput();
    if (!input) return;
    const fingerprint = JSON.stringify({ enabled: input.enabled, mappings: input.mappings });
    if (fingerprint === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      saveMappings.mutate(
        { toolId: tool.id, keyId: selectedKeyId, input },
        {
          onSuccess: () => {
            lastSavedRef.current = fingerprint;
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save mappings.")),
        },
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [buildMappingInput, selectedKeyId, mappingsQuery.data, saveMappings, tool.id, tool.mappingSupported]);

  const buildApplyInput = useCallback((): ApplyInput => {
    const modelSlots = Object.fromEntries(
      tool.defaultModels.map((model) => [
        model.alias,
        slotModels[model.alias] ?? model.defaultValue ?? model.id,
      ]),
    );
    const subagent = tool.defaultModels.find((model) => model.roleKind === "subagent");
    return {
      endpoint,
      apiKey: "",
      modelIds: tool.id === "claude" ? [] : activeModels,
      modelSlots,
      ...(activeModels[0] ? { activeModel: activeModels[0] } : {}),
      ...(subagent
        ? { subagentModel: slotModels[subagent.alias] ?? subagent.defaultValue ?? subagent.id }
        : {}),
      mappingOwnerId: selectedKeyId,
      ...(tool.mappingSupported ? { mapping: buildMappingInput() } : {}),
    };
  }, [
    activeModels,
    buildMappingInput,
    selectedKeyId,
    endpoint,
    slotModels,
    tool,
  ]);

  return (
    <Stack gap="16px">
      <Link
        to="/cli-tools"
        className="inline-flex items-center gap-3 text-caption text-accent"
      >
        <ArrowLeft size={14} />
        Back to CLI Tools
      </Link>

      <Card>
        <CardBody className="flex gap-7 items-start">
          <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={46} />
          <div className="flex-1 min-w-0">
            <Inline gap="8px" className="flex-wrap">
              <h1 className="text-title font-bold">{tool.name}</h1>
              {installed ? (
                <Badge tone="ok">Installed</Badge>
              ) : (
                <Badge tone="disabled">Not installed</Badge>
              )}
              {configured ? <Badge tone="accent">Configured</Badge> : null}
              {tool.configType === "guide" ? <Badge tone="info">Guide</Badge> : null}
            </Inline>
            <p className="mt-3 text-caption text-text-secondary">
              {tool.description}
            </p>
            {tool.docsUrl ? (
              <a
                href={tool.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block mt-3 text-caption text-accent"
              >
                Official documentation →
              </a>
            ) : null}

            {status?.settingsPath ? (
              <div
                className="font-mono tabular-nums mt-5 px-6 py-4 rounded-inset bg-surface-2 border border-inner-border text-badge text-text-secondary break-all"
              >
                Config file: {status.settingsPath}
              </div>
            ) : null}

            {status?.message ? (
              <div
                className={`mt-4 flex items-center gap-3 text-badge ${configured ? "text-green" : "text-orange"}`}
              >
                {configured ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {status.message}
              </div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Setup"
          subtitle="Pick the Apikey Name and endpoint, set the models, then download. The key's secret is read server-side — you never paste it."
          icon={<Settings2 size={16} />}
        />
        <CardBody>
          <Stack gap="12px">
            <div className="provider-grid grid gap-6">
              <div className="flex flex-col gap-3">
                <Select
                  label="Apikey Name"
                  id="api-key-select"
                  value={selectedKeyId}
                  onValueChange={setSelectedKeyId}
                  options={[
                    { value: "", label: "Select…" },
                    ...selectableKeys.map((key) => ({
                      value: key.id,
                      label: `${key.label} — ${key.keyMode === "personal" ? "Personal" : "Share template"}`,
                    })),
                  ]}
                />
                <div className="flex items-center gap-3 flex-wrap">
                  {selectedKey === undefined ? (
                    <span className="mt-1 text-badge text-text-tertiary">
                      Choose the Apikey Name whose routes this CLI session should use.
                    </span>
                  ) : cliEligible ? (
                    <>
                      <Badge tone="ok">routing:cli_mapping</Badge>
                      <span className="mt-1 text-badge text-text-tertiary">
                        Remote routes work with this key.
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge tone="warn" title="This key cannot resolve persisted CLI mappings on /v1/*. Turn on Remote Routing below to enable it.">
                        no CLI scope
                      </Badge>
                      <span className="mt-1 text-badge text-text-tertiary">
                        Remote routes stay inert on this key — turning on Remote Routing below will activate it.
                      </span>
                    </>
                  )}
                </div>
                {selectedKey?.keyMode === "share" ? (
                  <span className="mt-1 text-badge text-text-tertiary">
                    Share template: its child keys inherit these routes automatically.
                  </span>
                ) : null}
              </div>
              <Input
                label="Endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Model routing"
          icon={<Route size={16} />}
          subtitle={
            tool.mappingSupported
              ? "Left is the model name the CLI asks for. Right is the route Cartethyia sends it to. Leave a target empty to send that slot straight to the provider."
              : "The model names written into this tool's config."
          }
          action={
            tool.mappingSupported ? (
              <div className="flex items-center gap-5">
                <Switch
                checked={mappingEnabled}
                disabled={!selectedKeyId}
                onChange={(enabled) => {
                  setMappingEnabled(enabled);
                  if (!selectedKeyId) {
                    toast.error("Select an API key first to configure its Remote Routing.");
                    return;
                  }
                  // When Remote Routing is turned ON: auto-grant the routing:cli_mapping
                  // scope to this specific key so the routes immediately take effect.
                  if (enabled && selectedKey && !cliEligible) {
                    const nextScopes = [...new Set([...(selectedKey.scopes ?? []), "routing:cli_mapping"])];
                    updateApiKey.mutate(
                      { keyId: selectedKey.id, request: { scopes: nextScopes } },
                      {
                        onSuccess: () => {
                          toast.success(`Activated routing:cli_mapping on "${selectedKey.label}".`);
                        },
                        onError: (error) => {
                          toast.error(getErrorMessage(error, "Could not update key scope."));
                        },
                      },
                    );
                  }
                  const input = buildMappingInput();
                  if (input) {
                    saveMappings.mutate(
                      { toolId: tool.id, keyId: selectedKeyId, input: { ...input, enabled } },
                      {
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not save mappings.")),
                      },
                    );
                  }
                }}
                label={mappingEnabled ? "Remote Routing on" : "Remote Routing off"}
              />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!selectedKeyId || resetMappings.isPending}
                  onClick={() => {
                    if (!selectedKeyId) {
                      toast.error("Select an API key first.");
                      return;
                    }
                    resetMappings.mutate(
                      { toolId: tool.id, keyId: selectedKeyId },
                      {
                        onSuccess: () => {
                          setMappingEnabled(false);
                          setMappingTargets({});
                          toast.success("Remote routes cleared and Remote Routing turned off.");
                        },
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not reset remote routes.")),
                      },
                    );
                  }}
                >
                  {resetMappings.isPending ? "Resetting…" : "Reset"}
                </Button>
              </div>
            ) : undefined
          }
        />
        <CardBody>
          {!selectedKeyId ? (
            <p className="text-badge text-text-tertiary mb-5">
              Select an API key above to load and save remote routes for that key. You can still set models below to download a config file.
            </p>
          ) : null}

          {tool.mappingSupported ? (
            <div className="mb-5 flex items-center gap-4 rounded-inset border border-inner-border bg-surface-2 px-5 py-3 text-micro text-text-tertiary">
              <span className="flex-1">CLI asks for</span>
              <span className="w-9 text-center">→</span>
              <span className="flex-1">Cartethyia routes to</span>
            </div>
          ) : null}

          <Stack gap="6px">
            {tool.defaultModels.map((model) => {
              const slotValue = slotModels[model.alias] ?? model.defaultValue ?? model.id;
              const targetValue = mappingTargets[model.alias] ?? "";
              const sameAsSource = targetValue === slotValue;
              return (
                <div
                  key={model.alias}
                  className={`grid items-center gap-4 ${tool.mappingSupported ? "grid-cols-2" : "grid-cols-1"}`}
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setPickerFor(model.alias);
                        setPickerMode("slot");
                      }}
                      className="font-mono tabular-nums flex w-full min-w-0 cursor-pointer items-center justify-between gap-4 rounded-inset border border-inner-border bg-surface-2 px-5 py-3.5 text-left text-badge text-text-primary"
                    >
                      <span className="overflow-hidden truncate whitespace-nowrap">
                        {slotValue}
                      </span>
                      <Search size={12} className="text-text-tertiary shrink-0" />
                    </button>
                    <span className="text-micro text-text-tertiary pl-1">
                      {model.roleLabel ?? model.name}
                    </span>
                  </div>

                  {tool.mappingSupported ? (
                    <div className="flex flex-col gap-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => {
                          setPickerFor(model.alias);
                          setPickerMode("target");
                        }}
                        // A target that still points at its own source is inert; one that differs is
                        // the route this CLI call will take.
                        className={`font-mono tabular-nums flex w-full min-w-0 cursor-pointer items-center justify-between gap-4 rounded-inset border px-5 py-3.5 text-left text-badge ${sameAsSource ? "border-inner-border bg-surface-2 text-text-tertiary" : "border-accent bg-accent-soft text-text-primary"}`}
                      >
                        <span className="overflow-hidden truncate whitespace-nowrap">
                          {targetValue.length > 0 ? targetValue : "Not routed"}
                        </span>
                        <Search size={12} className="text-text-tertiary shrink-0" />
                      </button>
                      <span
                        className={`pl-1 text-micro ${targetValue.length === 0 ? "text-text-tertiary" : "text-accent"}`}
                      >
                        {targetValue.length === 0 ? "not routed" : "rerouted"}
                        {targetValue.length > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setMappingTargets((prev) => ({ ...prev, [model.alias]: "" }))
                            }
                            className="ml-3 border-none bg-none p-0 text-micro text-text-tertiary cursor-pointer underline"
                          >
                            clear
                          </button>
                        ) : null}
                      </span>
                      {blockedMappings.has(model.alias) ? (
                        <span
                          className="mt-1 flex items-center gap-3 text-micro text-orange"
                        >
                          <span>
                            {accessMode === "blacklist"
                              ? "This key blocks the target model."
                              : "This key does not allow the target model."}
                          </span>
                          <button
                            type="button"
                            disabled={updateApiKey.isPending}
                            onClick={() => allowModelForKey(targetValue)}
                            className={`border-none bg-none p-0 text-micro font-semibold text-accent underline ${updateApiKey.isPending ? "cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            {accessMode === "blacklist" ? "Unblock" : "Allow this model"}
                          </button>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Stack>
        </CardBody>
      </Card>

      {isGuide && tool.guideSteps ? (
        <Card>
          <CardHeader
            title="Guide"
            subtitle="Manual setup steps for tools that do not support file injection."
            icon={<BookOpen size={16} />}
          />
          <CardBody>
            <ol
              className="flex flex-col gap-6 pl-9"
            >
              {tool.guideSteps.map((step) => (
                <li key={step.step}>
                  <strong className="text-body">{step.title}</strong>
                  {step.desc ? (
                    <p
                      className="text-caption text-text-secondary mt-2"
                    >
                      {step.desc}
                    </p>
                  ) : null}
                  {step.value ? (
                    <pre
                      className="mt-3 overflow-x-auto rounded-control border border-inner-border bg-surface-2 p-5 font-mono text-badge"
                    >
                      {step.value.replace(/\{\{baseUrl\}\}/g, endpoint)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Config file"
          subtitle="Download the config file for this CLI tool. The selected API key secret is decrypted automatically into the download."
          icon={<FileCode2 size={16} />}
        />
        <CardBody className="flex flex-col gap-6">
          <div className="flex gap-4 flex-wrap justify-end">
            <Button
              variant="primary"
              icon={<Download size={14} />}
              onClick={() => {
                if (!selectedKeyId) {
                  toast.error("Select an API key first.");
                  return;
                }
                downloadTool.mutate(
                  { toolId: tool.id, keyId: selectedKeyId, input: buildApplyInput() },
                  {
                    onSuccess: (result) => {
                      downloadTextFile(result.filename, result.content, result.mimeType);
                      toast.success(`Downloaded ${result.filename}.`);
                    },
                    onError: (error) =>
                      toast.error(getErrorMessage(error, "Could not download config.")),
                  },
                );
              }}
              disabled={downloadTool.isPending || !canAct}
            >
              {downloadTool.isPending ? "Downloading…" : "Download config"}
            </Button>
          </div>
          {!canAct ? (
            <p className="text-badge text-text-tertiary text-right">
              {selectedKey?.keyMode === "share"
                ? "A share template has no secret to write into a config. Select a personal key to download the config file."
                : "Select an Apikey Name above to enable downloading the config file."}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <ModelPickerModal
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        selected={
          pickerFor
            ? [
                pickerMode === "target"
                  ? (mappingTargets[pickerFor] ?? slotModels[pickerFor] ?? "")
                  : (slotModels[pickerFor] ?? ""),
              ]
            : []
        }
        onToggle={() => {}}
        onSelectOne={(v) => {
          if (pickerFor) {
            if (pickerMode === "target") setMappingTargets((prev) => ({ ...prev, [pickerFor]: v }));
            else setSlotModels((prev) => ({ ...prev, [pickerFor]: v }));
          }
          setPickerFor(null);
        }}
        title={pickerFor ? `Select ${pickerFor} model` : "Select model"}
        multi={false}
      />
    </Stack>
  );
}
