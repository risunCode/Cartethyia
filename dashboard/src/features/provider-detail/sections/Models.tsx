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
import { memo, useMemo, useState, type ReactNode } from "react";
import { probeFailureToast, probeFailureToastArgs } from "./probe-toast";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { Banner } from "../../../components/patterns/banner";
import {
  useDeleteProviderModel,
  useProbeModel,
  useRegisterProviderModels,
  useSetModelEnabled,
} from "../../../hooks/providers";
import { formatModelTokens, UNKNOWN_LIMITS_TOOLTIP } from "../../../lib/format/tokens";
import { toast } from "../../../lib/toast";
import { useTrackedTimeout } from "../../../hooks/use-timeout";
import { PROBE_REASONING_EFFORTS, formatThinkingSuffix, type ModelCatalogEntry, type ProbeReasoningEffort } from "../../../data/contracts";
import { formatProbeDuration } from "../../../lib/format/numbers";



/**
 * The badge shown on a non-builtin card, naming where the row came from.
 *
 * `auto_free` is its own case rather than folded into "Fetched": a free-tier row
 * is discovered from a tier the provider publishes, and the section it sits in
 * says the same thing. Labelling it "Fetched" would make the badge disagree with
 * the section heading above it.
 */
function modelSourceTitle(source: string | null): string {
  if (source === "builtin") return "Built-in model";
  if (source === "auto_free") return "Free tier, discovered from the provider";
  if (source === "discovered") return "Fetched from provider";
  return "Added manually";
}

/** The badge label for a non-builtin source. */
function modelSourceBadge(source: string | null): string {
  if (source === "auto_free") return "Free tier";
  if (source === "discovered") return "Fetched";
  return "Manual";
}

/**
 * The four model groups, in the order the model list renders them.
 *
 * Order is a reading order, not a sort: the compiled catalog first (what ships),
 * then what the provider's free tier publishes, then the operator's own hand
 * additions, then the broad fetched tail. `source === null` is a row written
 * before the column existed; it is treated as built-in, which is the
 * conservative reading (disable, not delete) and matches the badge rule.
 *
 * Exported so a test can pin the grouping and its order without rendering.
 */
export const MODEL_GROUPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly matches: (source: string | null) => boolean;
}> = [
  {
    key: "builtin",
    label: "Built-in models",
    hint: "Compiled catalog — can be disabled, not deleted",
    matches: (source) => source === null || source === "builtin",
  },
  {
    key: "auto_free",
    label: "Free models (auto)",
    hint: "Discovered from the provider's free tier",
    matches: (source) => source === "auto_free",
  },
  {
    key: "manual",
    label: "Manually added",
    hint: "Added by hand from the Add Model dialog",
    matches: (source) => source === "manual",
  },
  {
    key: "fetched",
    label: "Fetched from provider",
    hint: "Listed by the provider's /v1/models",
    matches: (source) => source !== null && source !== "builtin" && source !== "auto_free" && source !== "manual",
  },
];

/**
 * Disabled rows, rendered last and apart from their origin group.
 *
 * `source` and `enabled` are different axes: a built-in row can be disabled and
 * a fetched row can be too, so the two cannot be one partition. This is applied
 * as a filter rather than a fifth source group, because a disabled row has not
 * become a different kind of row — it is still catalog, free, manual, or
 * fetched, and only its routing state changed. Parking those rows at the end
 * keeps a group the operator has switched most of off from filling the top of
 * the list with entries that cannot be routed.
 */
export const DISABLED_GROUP = {
  key: "disabled",
  label: "Disabled models",
  hint: "Turned off — not routable until re-enabled",
} as const;

/**
 * The reasoning effort a probe asks for.
 *
 * `auto` (the default) sends no reasoning intent at all, so the probe reflects
 * what the route does by itself — the right choice when the model's reasoning
 * support is exactly what is in question. A specific effort is sent only when
 * the operator picks one, which is how a probe can be made to follow a setting.
 *
 * The member list comes from the backend tuple (`PROBE_REASONING_EFFORTS`)
 * rather than a hand-written copy, so the selector cannot offer a value the
 * route schema rejects.
 */
/**
 * The options the thinking selector offers.
 *
 * Derived from the backend tuple (`PROBE_REASONING_EFFORTS`) rather than a
 * hand-written copy, so the selector cannot offer a value the route schema
 * rejects — a hand-written list drifts the moment the backend vocabulary does.
 * Exported so a test can pin the vocabulary without opening the Radix portal.
 */
export function probeThinkingOptions(): { value: ProbeReasoningEffort; label: string }[] {
  return PROBE_REASONING_EFFORTS.map((effort) => ({
    value: effort,
    label: effort === "auto" ? "Thinking: auto" : effort.charAt(0).toUpperCase() + effort.slice(1),
  }));
}

export function ThinkingSelect({
  value,
  onChange,
  disabled,
  id = "probe-thinking-effort",
}: {
  readonly value: ProbeReasoningEffort;
  readonly onChange: (value: ProbeReasoningEffort) => void;
  readonly disabled?: boolean;
  /** Distinct per call site: the section header and the Add-Model dialog can be
   * mounted at once, and two triggers sharing one DOM id is invalid. */
  readonly id?: string;
}): ReactNode {
  return (
    <div
      title="Reasoning effort every test in this section sends. Auto leaves the model's own reasoning default in place."
      className="min-w-74 shrink-0"
    >
      <Select
        id={id}
        aria-label="Thinking effort"
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as ProbeReasoningEffort)}
        options={probeThinkingOptions()}
      />
    </div>
  );
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
     * BYOK profile for custom). Used to order the wire choice so the provider's
     * own family comes first — not to restrict it: a manually added provider may
     * serve a protocol the gateway carries no bundled knowledge of, so the
     * operator must be able to select any wire family. */
    readonly supportedWireFamilies?: readonly string[];
  };
  readonly onClose: () => void;
}): ReactNode {
  const probe = useProbeModel();
  const register = useRegisterProviderModels();
  const [modelId, setModelId] = useState("");
  // The full vocabulary is always selectable, with the provider's declared
  // families offered first so the sensible choice is the default one. Locking
  // the list to the derived set made a manually added provider unable to reach
  // any wire outside it, which is the one thing this selector exists to do.
  const declaredWires = provider?.supportedWireFamilies;
  const preferredWire =
    provider?.wireFamilyDefault !== undefined &&
    (declaredWires === undefined || declaredWires.includes(provider.wireFamilyDefault))
      ? provider.wireFamilyDefault
      : declaredWires?.[0];
  const wireOptions = useMemo(() => {
    const all = ["chat", "responses", "messages"];
    const preferred = (declaredWires ?? []).filter((value) => all.includes(value));
    return [...preferred, ...all.filter((value) => !preferred.includes(value))];
  }, [declaredWires]);
  const [wireFamily, setWireFamily] = useState(preferredWire ?? "chat");
  const [thinking, setThinking] = useState<ProbeReasoningEffort>("auto");
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
      { providerId, request: { modelId: normalized, wireFamily, reasoningEffort: thinking, serviceKind: "llm" } },
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
    <Dialog open={true} onClose={onClose} title="Add Custom Model" size="sm" footer={
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={register.isPending}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={register.isPending || normalized.length === 0} onClick={handleAdd}>
          {register.isPending ? "Adding..." : "Add Model"}
        </Button>
      </>
    }>
      <Stack gap="10px">
        <Inline gap="8px" align="flex-end">
          <Input
            label="Model ID"
            autoFocus
            placeholder="e.g. gpt-4o, free-model-id"
            value={modelId}
            onChange={(event) => {
              setModelId(event.target.value);
              setTestState("idle");
              setTestError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && normalized.length > 0) runTest();
            }}
            className="flex-1"
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
            className="shrink-0"
          >
            {testState === "testing" ? "Testing..." : "Test"}
          </Button>
        </Inline>
        {wasPrefixed && (
          <div className="mt-1 text-badge text-text-tertiary">
            Using <span className="font-mono tabular-nums">{normalized}</span> (provider
            prefix removed).
          </div>
        )}
        <Select
          label="Wire family"
          id="add-model-wire-family"
          value={wireFamily}
          onValueChange={(value) => {
            setWireFamily(value);
            setTestState("idle");
            setTestError("");
          }}
          options={wireOptions.map((value) => ({ value, label: wireLabel(value) }))}
        />
        <div>
          <div
            className="text-badge font-semibold text-text-secondary mb-2"
          >
            Thinking
          </div>
          <ThinkingSelect
            id="add-model-thinking-effort"
            value={thinking}
            onChange={(next) => {
              setThinking(next);
              setTestState("idle");
              setTestError("");
            }}
            disabled={probe.isPending}
          />
          <div className="text-badge text-text-tertiary mt-2">
            Sent with the test. Auto leaves the model's own reasoning default in place.
          </div>
        </div>
        {declaredWires !== undefined && !declaredWires.includes(wireFamily) && (
          <div className="mt-1 text-badge text-text-tertiary">
            This provider does not declare the{" "}
            <span className="font-mono tabular-nums">{wireLabel(wireFamily)}</span> wire.
            The request is sent as chosen; the upstream decides whether it answers.
          </div>
        )}
        {testState === "passed" && (
          <Banner tone="success" live="status">
            Model test passed — ready to add.
          </Banner>
        )}
        {testState === "failed" && (
          <Banner tone="danger" live="alert">
            {testError || "Model test failed."}
          </Banner>
        )}
      </Stack>
    </Dialog>
  );
}

function ModelCard({
  providerId,
  model,
  serviceKind,
  searchCapable,
  thinkingEffort,
  onDeleteRequest,
  deletePending,
}: {
  readonly providerId: string;
  readonly model: ModelCatalogEntry;
  readonly serviceKind: "llm" | "websearch";
  /** Provider-level: the provider's adapter drives a hosted web-search tool. */
  readonly searchCapable: boolean;
  /** The section-wide reasoning effort, owned by the Models card header so one
   * setting governs every test in the section instead of each card carrying
   * its own — which is what made "set thinking, then test" need a per-card repeat. */
  readonly thinkingEffort: ProbeReasoningEffort;
  readonly onDeleteRequest: (model: ModelCatalogEntry) => void;
  readonly deletePending: boolean;
}): ReactNode {
  const probe = useProbeModel();
  const setEnabled = useSetModelEnabled();
  const [copied, setCopied] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; latencyMs: number } | null>(null);
  const scheduleCopyReset = useTrackedTimeout();

  // The routable id for this model under the section's thinking setting. The
  // suffix is what a client writes to ask for that level (`model(high)`), and
  // the backend parses it back off the name — so the copy button hands the
  // operator exactly the id the probe just used. `auto` means "no reasoning
  // intent", which is the bare id, not a `(auto)` suffix.
  const qualifiedId =
    serviceKind === "llm"
      ? formatThinkingSuffix(model.modelId, thinkingEffort === "auto" ? null : thinkingEffort)
      : model.modelId;
  const copyId = `${providerId}/${qualifiedId}`;
  const pendingLabel = serviceKind === "websearch" ? "Searching…" : "Thinking…";
  const runProbe = () => {
    probe.mutate(
      {
        providerId,
        request: {
          modelId: model.modelId,
          route: model.route,
          ...(serviceKind === "llm" ? { reasoningEffort: thinkingEffort } : {}),
          serviceKind,
        },
      },
      {
        onSuccess: (result) => {
          setProbeResult({ ok: result.ok, latencyMs: result.latencyMs });
          if (!result.ok) {
            const { title, detail } = probeFailureToast(providerId, qualifiedId, result.error);
            toast.error(title, detail);
            return;
          }
          const sample = result.sample?.trim() ?? "";
          toast.success(
            `${qualifiedId} · END ${formatProbeDuration(result.latencyMs)}`,
            sample || "No sample text in the response.",
          );
        },
        onError: (err) => {
          setProbeResult({ ok: false, latencyMs: 0 });
          toast.error(
            ...probeFailureToastArgs(
              providerId,
              qualifiedId,
              (err as { message?: string }).message,
            ),
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
        className={`model-card box-border flex w-full min-w-0 flex-1-auto flex-col gap-5 rounded-panel border border-inner-border p-6 ${model.enabled ? "bg-surface-2" : "bg-surface-1 opacity-72"}`}
      >
        {/* Header: icon tile + name (single-line ellipsis, no mid-token wrap) + copy */}
        <div className="flex items-start gap-4 min-w-0">
          <span
            className="inline-flex items-center justify-center w-13 h-13 rounded-inset bg-teal-soft text-teal shrink-0"
          >
            <Bot size={14} />
          </span>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              title={copyId}
              className="font-mono tabular-nums min-w-0 truncate text-caption font-semibold leading-[1.35]"
            >
              {qualifiedId}
            </div>
            <div
              className="flex items-center gap-3 min-w-0 text-micro text-text-tertiary"
            >
              <span
                title={`${model.wireFamily} · ${model.route ?? providerId}`}
                className="shrink-0 rounded-pill px-3 py-0.5 text-micro font-bold tracking-[0.04em]"
                // The wire family is a runtime value from the catalog, so its
                // chip colours stay inline.
                style={{ ...wireChipStyle(model.wireFamily) }}
              >
                {wireLabel(model.wireFamily)}
              </span>
              {model.source !== null && model.source !== "builtin" ? (
                <span
                  title={modelSourceTitle(model.source)}
                  className="shrink-0 rounded-pill border border-teal-soft px-3 py-0.5 text-micro font-bold tracking-[0.04em] text-teal"
                >
                  {modelSourceBadge(model.source)}
                </span>
              ) : null}
              {model.enabled ? null : (
                <span
                  className="shrink-0 rounded-pill bg-red-soft px-3 py-0.5 text-micro font-bold tracking-[0.04em] text-red"
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
            aria-label={`Copy ${copyId}`}
            title={`Copy ${copyId}`}
            onClick={() => {
              void navigator.clipboard?.writeText(copyId);
              setCopied(true);
              scheduleCopyReset(() => setCopied(false), 1500);
            }}
            className="shrink-0 p-2 opacity-70"
          />
        </div>

        {/* Meta: one quiet line — caps + latency live here, not inside the button */}
        <div
          className="flex items-center gap-3 min-w-0 text-badge text-text-secondary"
        >
          <span className="inline-flex gap-2.5">
            {model.reasoning ? (
              <span title="Reasoning" aria-label="Reasoning" className="inline-flex text-purple">
                <Brain size={12} />
              </span>
            ) : null}
            {model.vision ? (
              <span title="Vision" aria-label="Vision" className="inline-flex text-status-info">
                <Eye size={12} />
              </span>
            ) : null}
            {model.toolCall ? (
              <span title="Tool calling" aria-label="Tool calling" className="inline-flex text-orange">
                <Wrench size={12} />
              </span>
            ) : null}
            {searchCapable ? (
              <span title="Web search" aria-label="Web search" className="inline-flex text-teal">
                <Globe size={12} />
              </span>
            ) : null}
          </span>
          <span className="whitespace-nowrap">
            {model.contextLimit ? (
              `${formatModelTokens(model.contextLimit)} ctx`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                n/a ctx
              </span>
            )}
            {model.outputLimit ? (
              ` · ${formatModelTokens(model.outputLimit)} out`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                {` · n/a out`}
              </span>
            )}
          </span>
        </div>

        {/* Actions: equal-weight buttons; the thinking setting lives in the
            section header so it applies to the whole section at once. */}
        <div className="flex gap-3 items-center flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            disabled={probe.isPending}
            onClick={runProbe}
            aria-label={`Test ${qualifiedId}`}
            title={
              probe.isPending
                ? `Probing ${qualifiedId}…`
                : probeResult?.ok
                  ? `Last probe OK in ${formatProbeDuration(probeResult.latencyMs)} — click to re-test`
                  : probeResult
                    ? "Last probe failed — click to retry"
                    : `Test ${qualifiedId}`
            }
            className="flex-1 justify-center"
            icon={
              probe.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : probeResult ? (
                probeResult.ok ? (
                  <span className="inline-flex text-green">
                    <CheckCircle2 size={12} />
                  </span>
                ) : (
                  <span className="inline-flex text-red">
                    <AlertTriangle size={12} />
                  </span>
                )
              ) : (
                <FlaskConical size={12} />
              )
            }
          >
            {probe.isPending
              ? pendingLabel
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
            className={`flex-1 justify-center ${model.enabled ? "text-red" : "text-green"}`}
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
              className="model-card-delete shrink-0 px-4 py-3 text-text-tertiary"
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
  return "Chat";
}

export function ModelGrid({
  providerId,
  models,
  thinkingEffort,
  serviceKind = "llm",
  searchCapable = false,
}: {
  readonly providerId: string;
  readonly models: readonly ModelCatalogEntry[];
  readonly thinkingEffort: ProbeReasoningEffort;
  readonly serviceKind?: "llm" | "websearch";
  readonly searchCapable?: boolean;
}): ReactNode {
  const deleteModel = useDeleteProviderModel();
  const [deleteTarget, setDeleteTarget] = useState<ModelCatalogEntry | null>(null);
  // Built-in catalog rows and provider-sourced rows are different things: a
  // built-in row is the compiled catalog and can only be disabled, while a
  // fetched or manually added row is this deployment's own data and can be
  // deleted. Rendering them as one undifferentiated grid made a catalog entry
  // and an operator's own addition look alike, so the groups are labelled and
  // ordered — see `MODEL_GROUPS`.
  // A disabled row leaves its origin group and lands in `DISABLED_GROUP` at the
  // end, so each of the four source sections shows only what can actually be
  // routed. `enabled` defaults to true for a row written before the column
  // existed, matching the backend's own reading.
  const isRoutable = (model: ModelCatalogEntry): boolean => model.enabled !== false;
  const groups = MODEL_GROUPS.map((group) => ({
    ...group,
    rows: models.filter((model) => isRoutable(model) && group.matches(model.source)),
  })).filter((group) => group.rows.length > 0);
  const disabledRows = models.filter((model) => !isRoutable(model));
  const renderCard = (model: ModelCatalogEntry) => (
    <MemoModelCard
      key={`${model.modelId}::${model.route}`}
      providerId={providerId}
      model={model}
      serviceKind={serviceKind}
      searchCapable={searchCapable}
      thinkingEffort={thinkingEffort}
      deletePending={deleteModel.isPending}
      onDeleteRequest={setDeleteTarget}
    />
  );
  return (
    <>
      <Stack gap="16px">
        {groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-4">
            <div className="flex items-baseline gap-4 min-w-0">
              <span className="text-caption font-bold text-text-secondary">
                {group.label}
              </span>
              <span className="mt-1 text-badge text-text-tertiary">
                {group.rows.length}
              </span>
              <span
                title={group.hint}
                className="text-micro text-text-tertiary overflow-hidden truncate"
              >
                · {group.hint}
              </span>
            </div>
            <div className="provider-grid grid gap-4 items-stretch">
              {group.rows.map(renderCard)}
            </div>
          </section>
        ))}
        {disabledRows.length === 0 ? null : (
          <section className="flex flex-col gap-4">
            <div className="flex items-baseline gap-4 min-w-0">
              <span className="text-caption font-bold text-text-secondary">
                {DISABLED_GROUP.label}
              </span>
              <span className="mt-1 text-badge text-text-tertiary">
                {disabledRows.length}
              </span>
              <span
                title={DISABLED_GROUP.hint}
                className="text-micro text-text-tertiary overflow-hidden truncate"
              >
                · {DISABLED_GROUP.hint}
              </span>
            </div>
            <div className="provider-grid grid gap-4 items-stretch">
              {disabledRows.map(renderCard)}
            </div>
          </section>
        )}
      </Stack>
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
