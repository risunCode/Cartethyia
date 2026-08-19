
import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  CheckCircle2,
  CircleAlert,
  Globe2,
  Pencil,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
} from "lucide-solid";
import { sanitizeErrorMessage } from "@lib/api";
import {
  consoleFailure,
  createProxy,
  deleteProxy,
  fetchProxies,
  updateProxy,
  type ProxyInput,
  type ProxyRecord,
} from "@lib/console-api";
import { toast } from "@lib/toast";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Modal } from "@components/ui/modal";
import { StatePanel } from "@components/ui/state";
import { Switch } from "@components/ui/switch";
import { Input, Label } from "@components/ui/input";
import { StatusBadge, mapHealthToStatus, type StatusBadgeStatus } from "@components/shared/StatusBadge";
import { VirtualTable, type VirtualTableColumn } from "@components/shared/VirtualTable";
import { cn } from "@lib/cn";

/** Auto-refresh cadence for the proxy list (per Requirement 4). */
const PROXY_REFRESH_MS = 30_000;

const PROTOCOL_OPTIONS = ["http", "https", "socks5"] as const;
type ProxyProtocol = (typeof PROTOCOL_OPTIONS)[number];

const DEFAULT_FORM: ProxyFormState = {
  type: "http",
  host: "",
  port: 8080,
  priority: 0,
  weight: 1,
  max_concurrency: 10,
  active: true,
};

/** Mutable form state for create + edit modals. */
interface ProxyFormState {
  type: string;
  host: string;
  port: number;
  priority: number;
  weight: number;
  max_concurrency: number;
  active: boolean;
}

/** Maps a ProxyRecord to its current row in the table. */
type ProxyRow = ProxyRecord;

/**
 * Casts a partial ProxyInput to a normalized ProxyFormState for editing.
 * Falls back to safe defaults so a malformed daemon record still renders.
 */
function recordToForm(record: ProxyRecord): ProxyFormState {
  return {
    type: PROTOCOL_OPTIONS.includes(record.type as ProxyProtocol) ? record.type : "http",
    host: record.host ?? "",
    port: Number.isFinite(record.port) ? record.port : 8080,
    priority: Number.isFinite(record.priority) ? record.priority : 0,
    weight: Number.isFinite(record.weight) ? record.weight : 1,
    max_concurrency: Number.isFinite(record.max_concurrency) ? record.max_concurrency : 10,
    active: Boolean(record.active),
  };
}

/** Builds the create payload from a normalized form. */
function formToCreateInput(form: ProxyFormState): ProxyInput {
  return {
    type: form.type,
    host: form.host.trim(),
    port: form.port,
    priority: form.priority,
    weight: form.weight,
    max_concurrency: form.max_concurrency,
    active: form.active,
  };
}

/** Builds a partial update payload — only the fields the user actually changed. */
function formToUpdateInput(form: ProxyFormState, original: ProxyRecord): ProxyInput {
  const patch: ProxyInput = {};
  if (form.type !== original.type) patch.type = form.type;
  if (form.host.trim() !== original.host) patch.host = form.host.trim();
  if (form.port !== original.port) patch.port = form.port;
  if (form.priority !== original.priority) patch.priority = form.priority;
  if (form.weight !== original.weight) patch.weight = form.weight;
  if (form.max_concurrency !== original.max_concurrency) patch.max_concurrency = form.max_concurrency;
  if (form.active !== original.active) patch.active = form.active;
  return patch;
}

/** Formats a number for display, falling back to a dash for non-finite values. */
function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
}

/** Returns a short label for the protocol select. */
function protocolLabel(value: string): string {
  return value ? value.toUpperCase() : "—";
}

/** Derives a tone and label for the active toggle column. */
function activeView(active: boolean): { tone: "success" | "neutral"; label: string } {
  return active ? { tone: "success", label: "Active" } : { tone: "neutral", label: "Disabled" };
}

/**
 * Proxy management page — list, create, edit, and delete outbound proxy routes.
 *
 * Backed by the admin console routes:
 *   GET    /proxies
 *   POST   /proxies
 *   PATCH  /proxies/:proxyId
 *   DELETE /proxies/:proxyId
 *
 * The list auto-refreshes every 30 seconds while the tab is visible, mirroring
 * the cadence used by Quota and Settings so operators see fresh health state.
 */
export default function Proxy(): JSX.Element {
  const [resource, { refetch }] = createResource<ProxyRecord[]>(fetchProxies);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<ProxyRecord | null>(null);
  const [editing, setEditing] = createSignal<ProxyRecord | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [form, setForm] = createSignal<ProxyFormState>({ ...DEFAULT_FORM });
  const [formError, setFormError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const rows = createMemo<ProxyRow[]>(() => resource() ?? []);
  const initialLoading = createMemo(() => resource.loading && resource() === undefined);
  const errorInfo = createMemo(() => (resource.error ? consoleFailure(resource.error) : null));

  const summary = createMemo(() => {
    const list = rows();
    let active = 0;
    for (const row of list) if (row.active) active += 1;
    return { total: list.length, active };
  });

  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refetch();
    }, PROXY_REFRESH_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  const reportActionError = (cause: unknown, fallback: string): void => {
    const message = cause instanceof Error ? sanitizeErrorMessage(cause.message, fallback) : fallback;
    setActionError(message);
    toast.error(message);
  };

  const openCreate = (): void => {
    setEditing(null);
    setForm({ ...DEFAULT_FORM });
    setFormError(null);
    setCreateOpen(true);
  };

  const openEdit = (row: ProxyRecord): void => {
    setCreateOpen(false);
    setEditing(row);
    setForm(recordToForm(row));
    setFormError(null);
  };

  const closeForm = (): void => {
    setEditing(null);
    setCreateOpen(false);
    setFormError(null);
  };

  const toggleActive = async (row: ProxyRecord, next: boolean): Promise<void> => {
    setBusyId(row.id);
    setActionError(null);
    try {
      await updateProxy(row.id, { active: next });
      toast.success(`${row.host}:${row.port} ${next ? "enabled" : "disabled"}.`);
      await refetch();
    } catch (cause) {
      reportActionError(cause, "Failed to update proxy");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const row = pendingDelete();
    if (!row) return;
    setPendingDelete(null);
    setBusyId(row.id);
    setActionError(null);
    try {
      await deleteProxy(row.id);
      toast.success(`Deleted ${row.host}:${row.port}.`);
      await refetch();
    } catch (cause) {
      reportActionError(cause, "Failed to delete proxy");
    } finally {
      setBusyId(null);
    }
  };

  const validateForm = (state: ProxyFormState, isEdit: boolean): string | null => {
    if (!PROTOCOL_OPTIONS.includes(state.type as ProxyProtocol)) {
      return "Protocol must be http, https, or socks5.";
    }
    const host = state.host.trim();
    if (host.length === 0) return "Host is required.";
    if (/[\s@/\\?#\r\n\t]/.test(host)) return "Host cannot contain whitespace or @/?#.";
    if (!Number.isFinite(state.port) || state.port < 1 || state.port > 65535) {
      return "Port must be between 1 and 65535.";
    }
    if (isEdit) {
      if (!Number.isFinite(state.priority)) return "Priority must be an integer.";
      if (!Number.isFinite(state.weight) || state.weight < 1) return "Weight must be ≥ 1.";
      if (!Number.isFinite(state.max_concurrency) || state.max_concurrency < 1) {
        return "Max concurrency must be ≥ 1.";
      }
    }
    return null;
  };

  const submitForm = async (event: Event): Promise<void> => {
    event.preventDefault();
    const state = form();
    const editTarget = editing();
    const isEdit = editTarget !== null;
    const error = validateForm(state, isEdit);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    setActionError(null);
    try {
      if (isEdit) {
        const patch = formToUpdateInput(state, editTarget);
        if (Object.keys(patch).length === 0) {
          toast.info("No changes to save.");
          closeForm();
          return;
        }
        await updateProxy(editTarget.id, patch);
        toast.success(`Updated ${state.host.trim()}:${state.port}.`);
      } else {
        await createProxy(formToCreateInput(state));
        toast.success(`Added ${state.host.trim()}:${state.port}.`);
      }
      closeForm();
      await refetch();
    } catch (cause) {
      const message = cause instanceof Error ? sanitizeErrorMessage(cause.message, "Request failed") : "Request failed";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const updateForm = <K extends keyof ProxyFormState>(key: K, value: ProxyFormState[K]): void => {
    setForm({ ...form(), [key]: value });
  };

  const columns: VirtualTableColumn<ProxyRow>[] = [
    {
      key: "type",
      label: "Protocol",
      width: "110px",
      render: (row) => (
        <span
          class="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--hover)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-[var(--text-1)]"
          title={`Protocol: ${row.type}`}
        >
          <Globe2 size={11} aria-hidden="true" />
          {protocolLabel(row.type)}
        </span>
      ),
    },
    {
      key: "endpoint",
      label: "Endpoint",
      render: (row) => (
        <div class="min-w-0">
          <div class="truncate font-mono text-[11.5px] text-[var(--text-1)]">{row.host}</div>
          <div class="truncate font-mono text-[10px] text-[var(--text-3)]">
            <span>:{row.port}</span>
            <span class="mx-1">·</span>
            <span>priority {formatNumber(row.priority)}</span>
            <span class="mx-1">·</span>
            <span>weight {formatNumber(row.weight)}</span>
          </div>
        </div>
      ),
    },
    {
      key: "concurrency",
      label: "Max concurrency",
      align: "right",
      width: "150px",
      render: (row) => <span class="tabular-nums">{formatNumber(row.max_concurrency)}</span>,
    },
    {
      key: "health",
      label: "Health",
      width: "160px",
      render: (row) => {
        const status: StatusBadgeStatus = mapHealthToStatus(row.health);
        return (
          <div class="flex items-center gap-2">
            <StatusBadge status={status} label={status === "offline" ? "Unknown" : row.health} />
            <Show when={status === "down"}>
              <CircleAlert size={12} class="text-[var(--status-danger)]" aria-hidden="true" />
            </Show>
          </div>
        );
      },
    },
    {
      key: "active",
      label: "Active",
      align: "center",
      width: "110px",
      render: (row) => {
        const view = activeView(row.active);
        return (
          <div class="flex items-center justify-center gap-2">
            <Switch
              checked={row.active}
              disabled={busyId() === row.id}
              onChange={(next) => void toggleActive(row, next)}
              label={`${row.active ? "Deactivate" : "Activate"} ${row.host}:${row.port}`}
            />
            <Badge tone={view.tone} className="hidden lg:inline-flex">
              {view.label}
            </Badge>
          </div>
        );
      },
    },
    {
      key: "actions",
      label: "",
      align: "right",
      width: "110px",
      render: (row) => (
        <div class="flex items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={busyId() === row.id}
            onClick={() => openEdit(row)}
            aria-label={`Edit ${row.host}:${row.port}`}
            title="Edit proxy"
          >
            <Pencil size={13} aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busyId() === row.id}
            onClick={() => setPendingDelete(row)}
            aria-label={`Delete ${row.host}:${row.port}`}
            title="Delete proxy"
          >
            <Trash2 size={13} aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  const formModalTitle = (): string => (editing() ? "Edit proxy" : "Add proxy");
  const formSubmitLabel = (): string => {
    if (submitting()) return editing() ? "Saving…" : "Adding…";
    return editing() ? "Save changes" : "Add proxy";
  };

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Proxy Management</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Outbound proxy routes used by the gateway. Auto-refreshes every 30 seconds.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={resource.loading && resource() !== undefined}>
            <Badge tone="info">Refreshing…</Badge>
          </Show>
          <Show when={summary().total > 0}>
            <Badge tone="neutral">
              {summary().active}/{summary().total} active
            </Badge>
          </Show>
          <Button onClick={openCreate} variant="default" size="md" aria-label="Add proxy">
            <Plus size={14} aria-hidden="true" />
            Add proxy
          </Button>
        </div>
      </header>

      <Show when={actionError()}>
        {(message) => (
          <p class="text-[12px] font-medium text-[var(--status-danger)]" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Show
        when={!errorInfo()}
        fallback={
          <Show when={errorInfo()}>
            {(info) => (
              <StatePanel
                kind={info().degraded ? "degraded" : "error"}
                title={info().degraded ? "Proxy data degraded" : "Failed to load proxies"}
                description={`${info().message} (${info().code})`}
                action={
                  <Button variant="secondary" onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
              />
            )}
          </Show>
        }
      >
        <VirtualTable
          title="Proxies"
          subtitle={
            rows().length === 0
              ? "No proxies configured yet."
              : `${rows().length} configured route${rows().length === 1 ? "" : "s"} · toggle active or edit`
          }
          icon={ShieldCheck}
          iconColor="#30d158"
          items={rows()}
          columns={columns}
          rowKey={(row) => row.id}
          pageSize={50}
          loading={initialLoading()}
          emptyMessage="No proxies are configured. Click Add proxy to register one."
          ariaLabel="Outbound proxy routes"
          headerActions={
            <Button variant="secondary" size="sm" onClick={() => void refetch()} aria-label="Refresh proxy list">
              <Power size={12} aria-hidden="true" />
              Refresh
            </Button>
          }
        />
      </Show>

      <Show when={createOpen() || editing()}>
        <Modal
          open={createOpen() || editing() !== null}
          onOpenChange={(open) => (open ? null : closeForm())}
          title={formModalTitle()}
          wide
          footer={
            <>
              <Button variant="secondary" onClick={closeForm} disabled={submitting()}>
                Cancel
              </Button>
              <Button onClick={(event) => void submitForm(event)} disabled={submitting()}>
                {formSubmitLabel()}
              </Button>
            </>
          }
        >
          <ProxyFormFields form={form()} onUpdate={updateForm} error={formError()} disabled={submitting()} />
        </Modal>
      </Show>

      <Show when={pendingDelete()}>
        {(row) => (
          <Modal
            open
            title="Delete proxy?"
            onOpenChange={() => setPendingDelete(null)}
            footer={
              <>
                <Button variant="secondary" onClick={() => setPendingDelete(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={busyId() === row().id}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </Button>
              </>
            }
          >
            <p class="text-sm text-[var(--text-2)]">
              Permanently delete{" "}
              <span class="font-semibold text-[var(--text-1)]">
                {protocolLabel(row().type)} {row().host}:{row().port}
              </span>
              ? The gateway will no longer route traffic through this proxy.
            </p>
          </Modal>
        )}
      </Show>
    </div>
  );
}

/** Inline form fields for the create + edit modals. */
function ProxyFormFields(props: {
  form: ProxyFormState;
  onUpdate: <K extends keyof ProxyFormState>(key: K, value: ProxyFormState[K]) => void;
  error: string | null;
  disabled: boolean;
}): JSX.Element {
  const protocolValue = (): string =>
    PROTOCOL_OPTIONS.includes(props.form.type as ProxyProtocol) ? props.form.type : "http";

  const numericValue = (key: keyof ProxyFormState): string => {
    const raw = props.form[key];
    return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  };

  const setNumeric = (key: keyof ProxyFormState, raw: string, fallback: number): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      props.onUpdate(key, fallback);
      return;
    }
    const parsed = Number(trimmed);
    props.onUpdate(key, Number.isFinite(parsed) ? parsed : fallback);
  };

  const protocolId = "proxy-form-protocol";
  const hostId = "proxy-form-host";
  const portId = "proxy-form-port";
  const priorityId = "proxy-form-priority";
  const weightId = "proxy-form-weight";
  const concurrencyId = "proxy-form-max-concurrency";
  const activeId = "proxy-form-active";

  return (
    <form class="space-y-4" onSubmit={(event) => event.preventDefault()} novalidate>
      <Show when={props.error}>
        {(message) => (
          <p
            class="rounded-lg border border-[var(--status-danger)] bg-[var(--status-danger)]/10 px-3 py-2 text-[11.5px] text-[var(--status-danger)]"
            role="alert"
          >
            {message()}
          </p>
        )}
      </Show>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={protocolId}>Protocol</Label>
          <select
            id={protocolId}
            value={protocolValue()}
            disabled={props.disabled}
            onChange={(event) => props.onUpdate("type", event.currentTarget.value)}
            class={cn(
              "w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition-colors duration-150 focus:border-[var(--accent)] focus:bg-[var(--glass-bg-2)] disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <For each={PROTOCOL_OPTIONS}>
              {(option) => (
                <option value={option} selected={option === protocolValue()}>
                  {option.toUpperCase()}
                </option>
              )}
            </For>
          </select>
        </div>

        <div>
          <Label htmlFor={hostId}>Host</Label>
          <Input
            id={hostId}
            type="text"
            value={props.form.host}
            placeholder="proxy.example.com"
            autocomplete="off"
            spellcheck={false}
            disabled={props.disabled}
            onInput={(event) => props.onUpdate("host", event.currentTarget.value)}
          />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor={portId}>Port</Label>
          <Input
            id={portId}
            type="number"
            min={1}
            max={65535}
            step={1}
            value={numericValue("port")}
            disabled={props.disabled}
            onInput={(event) => setNumeric("port", event.currentTarget.value, 8080)}
          />
        </div>
        <div>
          <Label htmlFor={priorityId}>Priority</Label>
          <Input
            id={priorityId}
            type="number"
            step={1}
            value={numericValue("priority")}
            disabled={props.disabled}
            onInput={(event) => setNumeric("priority", event.currentTarget.value, 0)}
          />
          <p class="mt-1 text-[10px] text-[var(--text-3)]">Lower numbers are preferred.</p>
        </div>
        <div>
          <Label htmlFor={weightId}>Weight</Label>
          <Input
            id={weightId}
            type="number"
            min={1}
            step={1}
            value={numericValue("weight")}
            disabled={props.disabled}
            onInput={(event) => setNumeric("weight", event.currentTarget.value, 1)}
          />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Label htmlFor={concurrencyId}>Max concurrency</Label>
          <Input
            id={concurrencyId}
            type="number"
            min={1}
            step={1}
            value={numericValue("max_concurrency")}
            disabled={props.disabled}
            onInput={(event) => setNumeric("max_concurrency", event.currentTarget.value, 10)}
          />
          <p class="mt-1 text-[10px] text-[var(--text-3)]">Maximum in-flight requests through this proxy.</p>
        </div>
        <div class="flex flex-col">
          <Label htmlFor={activeId}>Active</Label>
          <div class="flex h-[42px] items-center">
            <Switch
              checked={props.form.active}
              disabled={props.disabled}
              onChange={(next) => props.onUpdate("active", next)}
              label={props.form.active ? "Active" : "Disabled"}
            />
            <CheckCircle2
              size={14}
              class={cn(
                "ml-2",
                props.form.active ? "text-[var(--status-success)]" : "text-[var(--text-3)]",
              )}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </form>
  );
}
