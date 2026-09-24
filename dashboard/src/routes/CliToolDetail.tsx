import { ArrowLeft, CheckCircle2, Download, Search, Settings2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state";
import { ModelPickerModal } from "../components/ModelPicker";
import { Switch } from "../components/ui/switch";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { downloadTextFile } from "../lib/download";
import { toast } from "../lib/toast";
import { useApiKeys } from "../lib/hooks/api-keys";
import {
  useApplyTool,
  useDownloadTool,
  useSaveToolMappings,
  useToolMappings,
  useToolRegistry,
  useToolStatuses,
} from "../lib/hooks/cli-tools";
import type { ApiKeyResponse, ApplyInput, CliMappingInput, ToolRegistryEntry, ToolStatus } from "../lib/contracts";
import { ToolIcon } from "./cli-tools/ToolIcon";
import { getErrorMessage } from "../lib/helpers";

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
        <Link to="/cli-tools" style={{ fontSize: "12px", color: "var(--accent)" }}>
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
  const mappingsQuery = useToolMappings(tool.id);
  const saveMappings = useSaveToolMappings();
  const downloadTool = useDownloadTool();
  const applyTool = useApplyTool();

  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [applyMode, setApplyMode] = useState<"file" | "remote" | "both">("both");
  const [endpoint, setEndpoint] = useState(() =>
    typeof window === "undefined" ? "http://localhost:12800" : window.location.origin,
  );
  const [slotModels, setSlotModels] = useState<Record<string, string>>({});
  const [mappingEnabled, setMappingEnabled] = useState(true);
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({});
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<"slot" | "target">("slot");
  useEffect(() => {
    if (!selectedKeyId && apiKeys.length > 0) setSelectedKeyId(apiKeys[0]!.id);
  }, [apiKeys, selectedKeyId]);

  // The selected key drives everything: the server decrypts its recoverable
  // secret, so the operator never pastes one. `cliEligible` reflects the
  // `routing:cli_mapping` scope, which is what lets a key resolve persisted
  // source→target mappings on /v1/* — a remote route is inert without it.
  const selectedKey = apiKeys.find((key) => key.id === selectedKeyId);
  const cliEligible = selectedKey?.scopes?.includes("routing:cli_mapping") === true;
  const pastedSecret = apiKey.trim();
  const canResolveSecret = pastedSecret.length > 0 || selectedKey !== undefined;

  useEffect(() => {
    const defaults = Object.fromEntries(
      tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
    );
    setSlotModels(defaults);
    // No saved mapping yet: leave every target empty so the UI can say "not
    // routed" and an apply sends the slot to the provider unchanged. Seeding
    // these with the source value made both sides read the same.
    setMappingTargets({});
  }, [tool]);

  useEffect(() => {
    const settings = mappingsQuery.data;
    if (!settings) return;
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
      return;
    }
    // Backend returned an empty mapping list — revert local slot/target
    // buffers to the tool defaults so a previously edited draft does not
    // survive a "reset to defaults" server-side.
    const defaults = Object.fromEntries(
      tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
    );
    setSlotModels(defaults);
    setMappingTargets({});
  }, [mappingsQuery.data, tool.defaultModels]);

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
    return {
      enabled: mappingEnabled,
      mappings: mappingEnabled
        ? tool.defaultModels
            .filter((model) => (mappingTargets[model.alias] ?? "").length > 0)
            .map((model) => ({
              slotKey: model.alias,
              sourceModel: slotModels[model.alias] ?? model.defaultValue ?? model.id,
              targetModel: mappingTargets[model.alias] ?? "",
              enabled: true,
            }))
            .filter((row) => row.targetModel.length > 0)
        : [],
    };
  }, [mappingEnabled, mappingTargets, slotModels, tool.defaultModels, tool.mappingSupported]);

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
      // The server resolves the secret from the selected key; a pasted value
      // wins when present so a key with no recoverable copy still works.
      apiKey: pastedSecret,
      ...(selectedKeyId ? { keyId: selectedKeyId } : {}),
      modelIds: tool.id === "claude" ? [] : activeModels,
      modelSlots,
      ...(activeModels[0] ? { activeModel: activeModels[0] } : {}),
      ...(subagent
        ? { subagentModel: slotModels[subagent.alias] ?? subagent.defaultValue ?? subagent.id }
        : {}),
      ...(tool.mappingSupported ? { mapping: buildMappingInput() } : {}),
      ...(tool.id === "claude" ? { bypassPermissions } : {}),
    };
  }, [
    activeModels,
    buildMappingInput,
    bypassPermissions,
    endpoint,
    pastedSecret,
    selectedKeyId,
    slotModels,
    tool,
  ]);

  return (
    <Stack gap="16px">
      <Link
        to="/cli-tools"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "12px",
          color: "var(--accent)",
        }}
      >
        <ArrowLeft size={14} />
        Back to CLI Tools
      </Link>

      <Card>
        <CardBody style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
          <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={46} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Inline gap="8px" style={{ flexWrap: "wrap" }}>
              <h1 style={{ fontSize: "18px", fontWeight: 700 }}>{tool.name}</h1>
              {installed ? (
                <Badge tone="ok">Installed</Badge>
              ) : (
                <Badge tone="disabled">Not installed</Badge>
              )}
              {configured ? <Badge tone="accent">Configured</Badge> : null}
              {tool.configType === "guide" ? <Badge tone="info">Guide</Badge> : null}
            </Inline>
            <p style={{ marginTop: "6px", fontSize: "12.5px", color: "var(--text-secondary)" }}>
              {tool.description}
            </p>
            {tool.docsUrl ? (
              <a
                href={tool.docsUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  marginTop: "6px",
                  display: "inline-block",
                  fontSize: "12px",
                  color: "var(--accent)",
                }}
              >
                Open docs
              </a>
            ) : null}
            {status?.settingsPath ? (
              <p
                style={{
                  marginTop: "8px",
                  fontSize: "11.5px",
                  color: "var(--text-tertiary)",
                  fontFamily: "monospace",
                }}
              >
                {status.settingsPath}
              </p>
            ) : tool.settingsFile ? (
              <p
                style={{
                  marginTop: "8px",
                  fontSize: "11.5px",
                  color: "var(--text-tertiary)",
                  fontFamily: "monospace",
                }}
              >
                {tool.settingsFile}
              </p>
            ) : null}
          </div>
          <Inline gap="6px" style={{ flexShrink: 0 }}>
            {configured ? (
              <CheckCircle2 size={16} color="var(--green)" />
            ) : (
              <XCircle size={16} color="var(--text-tertiary)" />
            )}
          </Inline>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Setup"
          subtitle="Pick the API key and endpoint, set the models, then apply or download. The key's secret is read server-side — you never paste it."
        />
        <CardBody>
          <Stack gap="12px">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <Select
                  label="API key"
                  id="api-key-select"
                  value={selectedKeyId}
                  onValueChange={setSelectedKeyId}
                  options={
                    apiKeys.length === 0
                      ? [{ value: "", label: "No API keys found" }]
                      : apiKeys.map((key) => ({
                          value: key.id,
                          label: key.scopes.includes("routing:cli_mapping")
                            ? `${key.label} — CLI mapping allowed`
                            : key.label,
                        }))
                  }
                />
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  {selectedKey === undefined ? null : cliEligible ? (
                    <Badge tone="ok">routing:cli_mapping</Badge>
                  ) : (
                    <Badge tone="warn" title="This key cannot resolve persisted CLI mappings on /v1/*. Add the routing:cli_mapping scope to use a remote route; a config file still works.">
                      no CLI scope
                    </Badge>
                  )}
                  {selectedKey === undefined ? null : (
                    <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                      {cliEligible
                        ? "Remote routes work with this key."
                        : "Remote routes stay inert on this key — only the config file applies."}
                    </span>
                  )}
                </div>
              </div>
              <Input
                label="Endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>

            <details>
              <summary
                style={{ fontSize: "11.5px", color: "var(--text-tertiary)", cursor: "pointer" }}
              >
                Use a pasted secret instead
              </summary>
              <div style={{ marginTop: "8px" }}>
                <Input
                  label="API key secret"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste a raw gateway API key"
                />
                <p style={{ marginTop: "6px", fontSize: "11.5px", color: "var(--text-tertiary)" }}>
                  Only needed for a key created before Cartethyia stored a recoverable copy. A
                  pasted secret overrides the selection above.
                </p>
              </div>
            </details>
          </Stack>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Model routing"
          subtitle={
            tool.mappingSupported
              ? "Left is the model name the CLI asks for. Right is the route Cartethyia sends it to. Leave a target empty to send that slot straight to the provider."
              : "The model names written into this tool's config."
          }
          action={
            tool.mappingSupported ? (
              <Switch
                checked={mappingEnabled}
                onChange={(enabled) => {
                  setMappingEnabled(enabled);
                  const input = buildMappingInput();
                  if (input)
                    saveMappings.mutate(
                      { toolId: tool.id, input: { ...input, enabled } },
                      {
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not save mappings.")),
                      },
                    );
                }}
                label={mappingEnabled ? "Routing on" : "Routing off"}
              />
            ) : undefined
          }
        />
        <CardBody>
          {tool.mappingSupported ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 10px",
                marginBottom: "10px",
                borderRadius: "8px",
                background: "var(--surface-2)",
                border: "1px solid var(--inner-border)",
                fontSize: "10.5px",
                color: "var(--text-tertiary)",
              }}
            >
              <span style={{ flex: 1 }}>CLI asks for</span>
              <span style={{ width: "18px", textAlign: "center" }}>&#8594;</span>
              <span style={{ flex: 1 }}>Cartethyia routes to</span>
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
                  style={{
                    display: "grid",
                    gridTemplateColumns: tool.mappingSupported ? "1fr 1fr" : "1fr",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickerFor(model.alias);
                        setPickerMode("slot");
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        padding: "7px 10px",
                        borderRadius: "8px",
                        border: "1px solid var(--inner-border)",
                        background: "var(--surface-2)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "11.5px",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        textAlign: "left",
                        width: "100%",
                        minWidth: 0,
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {slotValue}
                      </span>
                      <Search size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                    </button>
                    <span style={{ fontSize: "10px", color: "var(--text-tertiary)", paddingLeft: "2px" }}>
                      {model.roleLabel ?? model.name}
                    </span>
                  </div>

                  {tool.mappingSupported ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setPickerFor(model.alias);
                          setPickerMode("target");
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          padding: "7px 10px",
                          borderRadius: "8px",
                          border: `1px solid ${sameAsSource ? "var(--inner-border)" : "var(--accent)"}`,
                          background: sameAsSource ? "var(--surface-2)" : "var(--accent-soft)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "11.5px",
                          color: targetValue.length > 0 ? "var(--text-primary)" : "var(--text-tertiary)",
                          cursor: "pointer",
                          textAlign: "left",
                          width: "100%",
                          minWidth: 0,
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {targetValue.length > 0 ? targetValue : "Not routed"}
                        </span>
                        <Search size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                      </button>
                      <span
                        style={{
                          fontSize: "10px",
                          paddingLeft: "2px",
                          color: targetValue.length === 0 ? "var(--text-tertiary)" : "var(--accent)",
                        }}
                      >
                        {targetValue.length === 0 ? "not routed" : "rerouted"}
                        {targetValue.length > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setMappingTargets((prev) => ({ ...prev, [model.alias]: "" }))
                            }
                            style={{
                              marginLeft: "6px",
                              border: "none",
                              background: "none",
                              padding: 0,
                              fontSize: "10px",
                              color: "var(--text-tertiary)",
                              cursor: "pointer",
                              textDecoration: "underline",
                            }}
                          >
                            clear
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Stack>

          {tool.mappingSupported ? (
            <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const input = buildMappingInput();
                  if (input)
                    saveMappings.mutate(
                      { toolId: tool.id, input },
                      {
                        onSuccess: () => toast.success("Mappings saved."),
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not save mappings.")),
                      },
                    );
                }}
                disabled={saveMappings.isPending}
              >
                Save routing
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>
      {isGuide && tool.guideSteps ? (
        <Card>
          <CardHeader
            title="Guide"
            subtitle="Manual setup steps for tools that do not support file injection."
          />
          <CardBody>
            <ol
              style={{ display: "flex", flexDirection: "column", gap: "12px", paddingLeft: "18px" }}
            >
              {tool.guideSteps.map((step) => (
                <li key={step.step}>
                  <strong style={{ fontSize: "13px" }}>{step.title}</strong>
                  {step.desc ? (
                    <p
                      style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}
                    >
                      {step.desc}
                    </p>
                  ) : null}
                  {step.value ? (
                    <pre
                      style={{
                        marginTop: "6px",
                        padding: "10px",
                        borderRadius: "10px",
                        background: "var(--surface-2)",
                        border: "1px solid var(--inner-border)",
                        fontSize: "11.5px",
                        overflowX: "auto",
                      }}
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
          title="Apply"
          subtitle="Apply writes the tool's config on the gateway host and/or records the remote route. Download saves the config text for you to place yourself."
        />
        <CardBody style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
              Where to apply
            </span>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {(
                [
                  { id: "both", label: "File + remote" },
                  { id: "file", label: "Config file" },
                  { id: "remote", label: "Remote route" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={applyMode === option.id}
                  onClick={() => setApplyMode(option.id)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "99px",
                    fontSize: "12px",
                    cursor: "pointer",
                    border: `1px solid ${applyMode === option.id ? "var(--accent)" : "var(--inner-border)"}`,
                    background: applyMode === option.id ? "var(--accent-soft)" : "var(--surface-2)",
                    color: applyMode === option.id ? "var(--accent)" : "var(--text-secondary)",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              {applyMode === "file"
                ? "Writes the config on the gateway host. Only reaches your CLI when both run on the same machine."
                : applyMode === "remote"
                  ? "Saves the routing rows only — works with a remote or containerised gateway, no filesystem access."
                  : "Writes the config and saves the routing rows."}
              {applyMode !== "file" && !cliEligible
                ? " This key lacks routing:cli_mapping, so the remote route will not be used until you add that scope."
                : ""}
            </span>
          </div>

          {tool.id === "claude" ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "10px",
                background: "var(--surface-2)",
                border: "1px solid var(--inner-border)",
              }}
            >
              <div>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
                  Enable bypass permissions (YOLO mode)
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Allow Claude to run without permission prompts
                </div>
              </div>
              <Switch
                checked={bypassPermissions}
                onChange={setBypassPermissions}
                label="Enable bypass permissions (YOLO mode)"
              />
            </div>
          ) : null}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Button
              icon={<Settings2 size={14} />}
              onClick={() =>
                applyTool.mutate(
                  { toolId: tool.id, input: { ...buildApplyInput(), mode: applyMode } },
                  {
                    onSuccess: (result) => {
                      toast.success(result.message);
                    },
                    onError: (error) =>
                      toast.error(getErrorMessage(error, "Could not apply config.")),
                  },
                )
              }
              disabled={applyTool.isPending || !canResolveSecret}
            >
              {applyTool.isPending ? "Applying…" : "Apply"}
            </Button>
            <Button
              variant="secondary"
              icon={<Download size={14} />}
              onClick={() =>
                downloadTool.mutate(
                  { toolId: tool.id, input: buildApplyInput() },
                  {
                    onSuccess: (result) => {
                      downloadTextFile(result.filename, result.content, result.mimeType);
                      toast.success(`Downloaded ${result.filename}.`);
                    },
                    onError: (error) =>
                      toast.error(getErrorMessage(error, "Could not download config.")),
                  },
                )
              }
              disabled={downloadTool.isPending || !canResolveSecret}
            >
              {downloadTool.isPending ? "Downloading…" : "Download"}
            </Button>
          </div>
          {!canResolveSecret ? (
            <p style={{ fontSize: "11.5px", color: "var(--text-tertiary)", textAlign: "right" }}>
              Select an API key (or paste a secret) to enable apply and download.
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
