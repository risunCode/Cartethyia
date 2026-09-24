import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FlaskConical,
  Globe,
  Loader2,
  LockOpen,
  PowerOff,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import {
  useDeleteProviderModel,
  useProbeModel,
  useRegisterProviderModels,
  useSetModelEnabled,
} from "../../lib/hooks/providers";
import { UNKNOWN_LIMITS_TOOLTIP } from "../../lib/model-limits";
import { toast } from "../../lib/toast";
import { useTrackedTimeout } from "../../lib/use-timeout";
import type { ModelCatalogEntry } from "../../lib/contracts";

function formatModelTokens(value: number | null): string {
  if (value === null) return "\u2014";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}


function formatProbeDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function modelSourceTitle(source: string | null): string {
  if (source === "builtin") return "Built-in model";
  if (source === "discovered") return "Fetched from provider";
  return "Added manually";
}

export function AddModelModal({
  providerId,
  provider,
  onClose,
}: {
  readonly providerId: string;
  readonly provider?: {
    readonly isBuiltIn?: boolean;
    readonly wireFamilyDefault?: string;
    /** Families the backend resolved for this provider (registry for built-ins,
     * BYOK profile for custom). The Add-Model wire choice is constrained to
     * these so a probe can never target a wire the adapter rejects. */
    readonly supportedWireFamilies?: readonly string[];
  };
  readonly onClose: () => void;
}): ReactNode {
  const probe = useProbeModel();
  const register = useRegisterProviderModels();
  const [modelId, setModelId] = useState("");
  // The backend already derived which wires this provider may serve, so the
  // dashboard never re-derives the rule: a custom provider is locked to that
  // set (the operator's chosen default when it is among them, otherwise the
  // first declared family), and a built-in keeps the full vocabulary.
  const declaredWires = provider?.supportedWireFamilies;
  const preferredWire =
    provider?.wireFamilyDefault !== undefined &&
    (declaredWires === undefined || declaredWires.includes(provider.wireFamilyDefault))
      ? provider.wireFamilyDefault
      : declaredWires?.[0];
  const selectableWires =
    provider?.isBuiltIn === false && declaredWires !== undefined && declaredWires.length > 0
      ? declaredWires
      : undefined;
  const lockedWire = selectableWires?.length === 1 ? selectableWires[0] : undefined;
  const [wireFamily, setWireFamily] = useState(
    lockedWire ?? preferredWire ?? "chat",
  );
  const [testState, setTestState] = useState<"idle" | "testing" | "passed" | "failed">("idle");
  const [testError, setTestError] = useState("");

  const trimmed = modelId.trim();
  // Accept a pasted qualified id (`cline/cline-free/…`): the provider is
  // already selected by the page, so its prefix is stripped. Without this the
  // probe dispatches a literally-prefixed id upstream and always 404s.
  const normalized =
    trimmed.toLowerCase().startsWith(`${providerId.toLowerCase()}/`) && trimmed.length > providerId.length + 1
      ? trimmed.slice(providerId.length + 1)
      : trimmed;
  const wasPrefixed = normalized !== trimmed;

  const runTest = () => {
    if (!normalized) return;
    setTestState("testing");
    setTestError("");
    probe.mutate(
      { providerId, request: { modelId: normalized, wireFamily } },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setTestState("passed");
          } else {
            setTestState("failed");
            setTestError(result.error ?? "Model probe failed");
          }
        },
        onError: (err) => {
          setTestState("failed");
          setTestError((err as { message?: string }).message ?? "Model probe failed");
        },
      },
    );
  };

  const handleAdd = () => {
    if (!normalized) return;
    register.mutate(
      { providerId, modelIds: [normalized], wireFamily },
      {
        onSuccess: () => {
          toast.success("Custom model added", `Sent to ${providerId}/${normalized}`);
          onClose();
        },
        onError: (err) =>
          toast.error(
            "Failed to add model",
            (err as { message?: string }).message ?? "Unable to register model",
          ),
      },
    );
  };

  return (
    <Dialog open={true} onClose={onClose} title="Add Custom Model" width={440}>
      <Stack gap="10px">
        <Inline gap="8px" align="flex-end">
          <Input
            label="Model ID"
            autoFocus
            placeholder="e.g. gpt-4o, cline-free/deepseek-v4.1-flash"
            value={modelId}
            onChange={(event) => {
              setModelId(event.target.value);
              setTestState("idle");
              setTestError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && normalized.length > 0) runTest();
            }}
            style={{ flex: 1 }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={
              testState === "testing" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FlaskConical size={13} />
              )
            }
            disabled={probe.isPending || normalized.length === 0}
            onClick={runTest}
            style={{ flexShrink: 0 }}
          >
            {testState === "testing" ? "Testing..." : "Test"}
          </Button>
        </Inline>
        {wasPrefixed && (
          <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            Using <span style={{ fontFamily: "var(--font-mono)" }}>{normalized}</span> (provider
            prefix removed).
          </div>
        )}
        {lockedWire === undefined ? (
          <Select
            label="Wire family"
            id="add-model-wire-family"
            value={wireFamily}
            onValueChange={(value) => {
              setWireFamily(value);
              setTestState("idle");
              setTestError("");
            }}
            options={(selectableWires ?? ["chat", "responses", "messages", "native"]).map(
              (value) => ({ value, label: wireLabel(value) }),
            )}
          />
        ) : null}
        {testState === "passed" && (
          <div
            style={{
              borderRadius: "10px",
              border: "1px solid color-mix(in srgb, var(--green) 40%, transparent)",
              background: "color-mix(in srgb, var(--green) 8%, transparent)",
              padding: "8px 10px",
              fontSize: "11.5px",
              color: "var(--green)",
            }}
          >
            Model test passed — ready to add.
          </div>
        )}
        {testState === "failed" && (
          <div
            style={{
              borderRadius: "10px",
              border: "1px solid color-mix(in srgb, var(--red) 40%, transparent)",
              background: "color-mix(in srgb, var(--red) 8%, transparent)",
              padding: "8px 10px",
              fontSize: "11.5px",
              color: "var(--red)",
            }}
          >
            {testError || "Model test failed."}
          </div>
        )}
        <Inline justify="flex-end" gap="8px" style={{ marginTop: "6px" }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={register.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={register.isPending || normalized.length === 0}
            onClick={handleAdd}
          >
            {register.isPending ? "Adding..." : "Add Model"}
          </Button>
        </Inline>
      </Stack>
    </Dialog>
  );
}

function ModelCard({
  providerId,
  model,
  onDeleteRequest,
  deletePending,
}: {
  readonly providerId: string;
  readonly model: ModelCatalogEntry;
  readonly onDeleteRequest: (model: ModelCatalogEntry) => void;
  readonly deletePending: boolean;
}): ReactNode {
  const probe = useProbeModel();
  const setEnabled = useSetModelEnabled();
  const [copied, setCopied] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; latencyMs: number } | null>(null);
  const scheduleCopyReset = useTrackedTimeout();


  const runProbe = () => {
    probe.mutate(
      { providerId, request: { modelId: model.modelId, route: model.route } },
      {
        onSuccess: (result) => {
          setProbeResult({ ok: result.ok, latencyMs: result.latencyMs });
          if (!result.ok) {
            toast.error(`${model.modelId} probe failed`, result.error ?? "Unknown error");
            return;
          }
          const sample = result.sample?.trim() ?? "";
          toast.success(
            `${model.modelId} · END ${formatProbeDuration(result.latencyMs)}`,
            sample || "No sample text in the response.",
          );
        },
        onError: (err) => {
          setProbeResult({ ok: false, latencyMs: 0 });
          toast.error(
            `${model.modelId} probe failed`,
            (err as { message?: string }).message ?? "Model probe failed",
          );
        },
      },
    );
  };

  const toggleEnabled = () => {
    const nextEnabled = !model.enabled;
    setEnabled.mutate(
      { providerId, request: { modelId: model.modelId, route: model.route, enabled: nextEnabled } },
      {
        onSuccess: () =>
          toast.success(nextEnabled ? "Model enabled" : "Model disabled", model.modelId),
        onError: (err) =>
          toast.error(
            "Failed to update model",
            (err as { message?: string }).message ?? "Unable to update model",
          ),
      },
    );
  };
  return (
    <>
      <div
        className="model-card"
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          gap: "10px",
          padding: "12px",
          border: "1px solid var(--inner-border)",
          borderRadius: "12px",
          background: model.enabled ? "var(--surface-2)" : "var(--surface-1)",
          opacity: model.enabled ? 1 : 0.72,
        }}
      >
        {/* Header: icon tile + name (single-line ellipsis, no mid-token wrap) + copy */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "26px",
              height: "26px",
              borderRadius: "8px",
              background: "var(--teal-soft)",
              color: "var(--teal)",
              flexShrink: 0,
            }}
          >
            <Bot size={14} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
            <div
              title={`${providerId}/${model.modelId}`}
              style={{
                minWidth: 0,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              {model.modelId}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                minWidth: 0,
                fontSize: "10px",
                color: "var(--text-tertiary)",
              }}
            >
              <span
                title={`${model.wireFamily} · ${model.route ?? providerId}`}
                style={{
                  flexShrink: 0,
                  fontSize: "9px",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  padding: "1px 6px",
                  borderRadius: "999px",
                  ...wireChipStyle(model.wireFamily),
                }}
              >
                {wireLabel(model.wireFamily)}
              </span>
              {model.source !== null && model.source !== "builtin" ? (
                <span
                  title={modelSourceTitle(model.source)}
                  style={{
                    flexShrink: 0,
                    fontSize: "9px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    padding: "1px 6px",
                    borderRadius: "999px",
                    color: "var(--teal)",
                    border: "1px solid color-mix(in srgb, var(--teal) 35%, transparent)",
                  }}
                >
                  Fetched
                </span>
              ) : null}
              {model.enabled ? null : (
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: "9px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    padding: "1px 6px",
                    borderRadius: "999px",
                    background: "var(--red-soft)",
                    color: "var(--red)",
                  }}
                >
                  Off
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={copied ? <Check size={12} /> : <Copy size={12} />}
            aria-label={`Copy ${model.modelId}`}
            title={`Copy ${providerId}/${model.modelId}`}
            onClick={() => {
              void navigator.clipboard?.writeText(`${providerId}/${model.modelId}`);
              setCopied(true);
              scheduleCopyReset(() => setCopied(false), 1500);
            }}
            style={{ flexShrink: 0, padding: "4px", opacity: 0.7 }}
          />
        </div>

        {/* Meta: one quiet line — caps + latency live here, not inside the button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
            fontSize: "11px",
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ display: "inline-flex", gap: "5px" }}>
            {model.reasoning ? (
              <span title="Reasoning" aria-label="Reasoning" style={{ display: "inline-flex", color: "var(--purple)" }}>
                <Brain size={12} />
              </span>
            ) : null}
            {model.vision ? (
              <span title="Vision" aria-label="Vision" style={{ display: "inline-flex", color: "var(--status-info)" }}>
                <Eye size={12} />
              </span>
            ) : null}
            {model.toolCall ? (
              <span title="Tool calling" aria-label="Tool calling" style={{ display: "inline-flex", color: "var(--orange)" }}>
                <Wrench size={12} />
              </span>
            ) : null}
            {model.webSearch ? (
              <span title="Web search" aria-label="Web search" style={{ display: "inline-flex", color: "var(--teal)" }}>
                <Globe size={12} />
              </span>
            ) : null}
          </span>
          <span style={{ whiteSpace: "nowrap" }}>
            {model.contextLimit ? (
              `${formatModelTokens(model.contextLimit)} ctx`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} style={{ cursor: "help" }}>
                n/a ctx
              </span>
            )}
            {model.outputLimit ? (
              ` · ${formatModelTokens(model.outputLimit)} out`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} style={{ cursor: "help" }}>
                {` · n/a out`}
              </span>
            )}
          </span>
        </div>

        {/* Actions: single row, equal weights — delete is a quiet icon, not a full-width alarm */}
        <div style={{ display: "flex", gap: "6px" }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={probe.isPending}
            onClick={runProbe}
            aria-label={`Test ${model.modelId}`}
            title={
              probe.isPending
                ? `Probing ${model.modelId}…`
                : probeResult?.ok
                  ? `Last probe OK in ${formatProbeDuration(probeResult.latencyMs)} — click to re-test`
                  : probeResult
                    ? "Last probe failed — click to retry"
                    : `Test ${model.modelId}`
            }
            style={{ flex: 1, justifyContent: "center" }}
            icon={
              probe.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : probeResult ? (
                probeResult.ok ? (
                  <span style={{ display: "inline-flex", color: "var(--green)" }}>
                    <CheckCircle2 size={12} />
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", color: "var(--red)" }}>
                    <AlertTriangle size={12} />
                  </span>
                )
              ) : (
                <FlaskConical size={12} />
              )
            }
          >
            {probe.isPending
              ? "Thinking…"
              : probeResult?.ok
                ? formatProbeDuration(probeResult.latencyMs)
                : probeResult
                  ? "Fail"
                  : "Test"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={setEnabled.isPending}
            onClick={toggleEnabled}
            icon={model.enabled ? <PowerOff size={12} /> : <LockOpen size={12} />}
            aria-label={model.enabled ? `Disable ${model.modelId}` : `Enable ${model.modelId}`}
            title={model.enabled ? "Disable model" : "Enable model"}
            style={{
              flex: 1,
              justifyContent: "center",
              color: model.enabled ? "var(--red)" : "var(--green)",
            }}
          >
            {model.enabled ? "Disable" : "Enable"}
          </Button>
          {/* Built-in models are immutable catalog: disable only, never delete. */}
          {model.source === "builtin" ? null : (
            <Button
              variant="ghost"
              size="sm"
              disabled={deletePending}
              onClick={() => onDeleteRequest(model)}
              icon={<Trash2 size={12} />}
              aria-label={`Delete ${model.modelId}`}
              title="Delete model"
              className="model-card-delete"
              style={{ flexShrink: 0, padding: "6px 8px", color: "var(--text-tertiary)" }}
            />
          )}
        </div>
      </div>
    </>
  );
}

const MemoModelCard = memo(ModelCard);

/** Wire-family chip colors: chat = teal, responses = purple, messages = orange. */
function wireChipStyle(wireFamily: string): { color: string; background: string } {
  if (wireFamily === "responses") return { color: "var(--purple)", background: "var(--purple-soft)" };
  if (wireFamily === "messages") {
    return {
      color: "var(--orange)",
      background: "color-mix(in srgb, var(--orange) 14%, transparent)",
    };
  }
  return { color: "var(--teal)", background: "var(--teal-soft)" };
}

function wireLabel(wireFamily: string): string {
  const lower = wireFamily.toLowerCase();
  if (lower === "responses") return "Responses";
  if (lower === "messages") return "Messages";
  if (lower === "native") return "Native";
  return "Chat";
}

export function ModelGrid({
  providerId,
  models,
}: {
  readonly providerId: string;
  readonly models: readonly ModelCatalogEntry[];
}): ReactNode {
  const deleteModel = useDeleteProviderModel();
  const [deleteTarget, setDeleteTarget] = useState<ModelCatalogEntry | null>(null);
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "8px",
          alignItems: "stretch",
        }}
      >
        {models.map((model) => (
          <MemoModelCard
            key={`${model.modelId}::${model.route}`}
            providerId={providerId}
            model={model}
            deletePending={deleteModel.isPending}
            onDeleteRequest={setDeleteTarget}
          />
        ))}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleteModel.isPending) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (deleteTarget === null) return;
          await deleteModel.mutateAsync({
            providerId,
            request: { modelId: deleteTarget.modelId, route: deleteTarget.route },
          });
          toast.success("Model deleted", `${providerId}/${deleteTarget.modelId}`);
          setDeleteTarget(null);
        }}
        title="Delete model?"
        message={`Delete ${providerId}/${deleteTarget?.modelId ?? ""} from the provider catalog?`}
        confirmLabel="Delete"
        danger
      />
    </>
  );
}
