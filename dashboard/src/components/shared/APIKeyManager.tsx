
import { For, Show, createSignal, type JSX } from "solid-js";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input, Label } from "../ui/input";
import { Switch } from "../ui/switch";

export interface APIKeyRecord {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly scope?: string;
}

export interface APIKeyManagerProps {
  keys: readonly APIKeyRecord[];
  onCreate?: (input: { label: string; scope: string }) => Promise<void> | void;
  onRevoke?: (id: string) => Promise<void> | void;
  onToggle?: (id: string, active: boolean) => Promise<void> | void;
  creating?: boolean;
  className?: string;
}

/**
 * Operator-facing API key management surface. New keys are created with a
 * label and optional scope; existing keys can be toggled or revoked without
 * the page itself owning the network calls.
 */
export function APIKeyManager(props: APIKeyManagerProps): JSX.Element {
  const [label, setLabel] = createSignal("");
  const [scope, setScope] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const handleCreate = async (event: Event) => {
    event.preventDefault();
    const trimmedLabel = label().trim();
    if (!trimmedLabel || !props.onCreate) return;
    setBusy("create");
    setError(null);
    try {
      await props.onCreate({ label: trimmedLabel, scope: scope().trim() });
      setLabel("");
      setScope("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create key");
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!props.onRevoke) return;
    setBusy(id);
    setError(null);
    try {
      await props.onRevoke(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke key");
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (id: string, active: boolean) => {
    if (!props.onToggle) return;
    setBusy(id);
    setError(null);
    try {
      await props.onToggle(id, active);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update key");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class={cn("flex flex-col gap-4", props.className)}>
      <Show when={props.onCreate}>
        <form
          class="settings-slide-down rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3"
          onSubmit={handleCreate}
          aria-label="Create API key"
        >
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="apikey-label">Label</Label>
              <Input
                id="apikey-label"
                placeholder="prod-bot"
                value={label()}
                onInput={(event) => setLabel(event.currentTarget.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="apikey-scope">Scope</Label>
              <Input
                id="apikey-scope"
                placeholder="chat, completion"
                value={scope()}
                onInput={(event) => setScope(event.currentTarget.value)}
              />
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between gap-2">
            <Show when={error()}>
              {(message) => <span class="text-[11px] text-[var(--status-danger)]">{message()}</span>}
            </Show>
            <Button type="submit" size="sm" disabled={busy() === "create" || props.creating}>
              {busy() === "create" ? "Creating…" : "Create key"}
            </Button>
          </div>
        </form>
      </Show>

      <ul class="flex flex-col gap-2" role="list">
        <For each={props.keys}>
          {(key) => (
            <li class="flex flex-col gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-1)] p-3 transition-colors duration-150 hover:bg-[var(--hover)] sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-[12.5px] font-semibold text-[var(--text-1)]">{key.label}</span>
                  <Badge tone={key.active ? "ok" : "neutral"}>{key.active ? "Active" : "Inactive"}</Badge>
                  <Show when={key.scope}>
                    {(scope) => <Badge tone="info">{scope()}</Badge>}
                  </Show>
                </div>
                <div class="mt-1 flex flex-wrap items-baseline gap-2 text-[11px] text-[var(--text-3)]">
                  <span class="font-mono">{key.prefix}…</span>
                  <span>created {key.createdAt}</span>
                  <Show when={key.lastUsedAt}>
                    {(lastUsed) => <span>last used {lastUsed()}</span>}
                  </Show>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Show when={props.onToggle}>
                  <Switch
                    checked={key.active}
                    onChange={(next) => void handleToggle(key.id, next)}
                    label={`Toggle ${key.label}`}
                    disabled={busy() === key.id}
                  />
                </Show>
                <Show when={props.onRevoke}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRevoke(key.id)}
                    disabled={busy() === key.id}
                  >
                    Revoke
                  </Button>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.keys.length === 0}>
        <div class="rounded-[var(--radius-control)] border border-dashed border-[var(--inner-border)] p-6 text-center text-[12px] text-[var(--text-3)]">
          No API keys yet. Create one above to grant access.
        </div>
      </Show>
    </div>
  );
}
