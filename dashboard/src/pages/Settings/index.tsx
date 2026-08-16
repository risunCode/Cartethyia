
import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { Card, CardHeader } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Label } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Badge, Skeleton } from "../../components/ui/badge";
import { SettingRow, SettingSection } from "../../components/patterns/setting-row";
import { APIKeyManager, type APIKeyRecord } from "../../components/shared/APIKeyManager";
import { sidebarCollapsed, setSidebarCollapsed, setTheme, theme } from "../../lib/store";
import { consoleFailure, consoleGet, consolePatch } from "../../lib/console-api";

interface SettingsResponse {
  readonly theme?: string;
  readonly sidebarCollapsed?: boolean;
  readonly solidMode?: boolean;
  readonly performanceMode?: boolean;
  readonly apiKeys?: readonly APIKeyRecord[];
  readonly notificationsEnabled?: boolean;
  readonly defaultModel?: string;
}

const SETTINGS_ENDPOINT = "/settings";

export default function Settings(): JSX.Element {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [busyKeyId, setBusyKeyId] = createSignal<string | null>(null);
  const [creatingKey, setCreatingKey] = createSignal(false);

  const [settingsResource] = createResource<SettingsResponse, number>(
    refreshTick,
    async () => {
      try {
        return await consoleGet<SettingsResponse>(SETTINGS_ENDPOINT);
      } catch (cause) {
        const failure = consoleFailure(cause);
        setError(failure?.message ?? "Request failed");
        throw cause;
      }
    },
  );

  const apiKeys = createMemo<readonly APIKeyRecord[]>(
    () => (settingsResource.error ? [] : settingsResource()?.apiKeys ?? []),
  );

  const isLoading = createMemo(() => settingsResource.loading);
  const failure = createMemo(() => (settingsResource.error ? consoleFailure(settingsResource.error) : null));

  const patchSetting = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const response = await consolePatch<SettingsResponse>(SETTINGS_ENDPOINT, body);
      setRefreshTick((tick) => tick + 1);
      return response;
    } catch (cause) {
      setError(consoleFailure(cause)?.message ?? "Request failed");
      return null;
    }
  };

  const handleCreateKey = async (input: { label: string; scope: string }) => {
    setCreatingKey(true);
    try {
      await patchSetting({
        apiKeyAction: "create",
        apiKeyLabel: input.label,
        apiKeyScope: input.scope,
      });
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    setBusyKeyId(id);
    try {
      await patchSetting({ apiKeyAction: "revoke", apiKeyId: id });
    } finally {
      setBusyKeyId(null);
    }
  };

  const handleToggleKey = async (id: string, active: boolean) => {
    setBusyKeyId(id);
    try {
      await patchSetting({ apiKeyAction: active ? "enable" : "disable", apiKeyId: id });
    } finally {
      setBusyKeyId(null);
    }
  };

  return (
    <div class="space-y-6">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold text-[var(--text-1)]">Settings</h1>
          <p class="mt-1 text-[12px] text-[var(--text-3)]">
            Operator preferences, dashboard behaviour, and API key management.
          </p>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-[var(--text-3)]">
          <Show when={isLoading()}>
            <span
              class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-warning)]"
              aria-hidden="true"
            />
            Loading…
          </Show>
          <Show when={!isLoading() && !settingsResource.error && settingsResource()}>
            <span class="inline-block h-1.5 w-1.5 rounded-full bg-[var(--status-success)]" aria-hidden="true" />
            Synced
          </Show>
          <Show when={failure()}>
            {(status) => <Badge tone="err">{status().message}</Badge>}
          </Show>
        </div>
      </header>

      <Show
        when={!isLoading()}
        fallback={
          <div class="grid gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-32" />
          </div>
        }
      >
        <AppearanceSection onThemePatch={(value) => patchSetting({ theme: value })} />
        <LayoutSection />
        <APIKeysSection
          keys={apiKeys()}
          creating={creatingKey()}
          onCreate={handleCreateKey}
          onRevoke={handleRevokeKey}
          onToggle={handleToggleKey}
          busyKeyId={busyKeyId()}
        />
      </Show>

      <Show when={error()}>
        {(message) => (
          <p class="text-[12px] text-[var(--status-danger)]" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Card density="compact">
        <CardHeader title="Endpoint reference" sub="Console API route contract for these settings" />
        <dl class="grid gap-2 text-[11.5px] sm:grid-cols-2">
          <Row label="Method" value="GET / PATCH" />
          <Row label="Route" value="/settings" />
          <Row label="Cache TTL" value="5 minutes (apiCache)" />
          <Row label="Auth" value="Console session cookie" />
        </dl>
      </Card>
    </div>
  );
}

function AppearanceSection(props: {
  onThemePatch: (theme: "light" | "dark" | "system") => Promise<unknown>;
}): JSX.Element {
  const [pending, setPending] = createSignal<string | null>(null);
  const handleThemeChange = async (next: "light" | "dark" | "system") => {
    setTheme(next);
    setPending(next);
    await props.onThemePatch(next);
    setPending(null);
  };

  return (
    <Card density="comfortable" className="settings-slide-down">
      <CardHeader title="Appearance" sub="Theme and glass treatment" />
      <SettingSection title="Theme">
        <SettingRow
          label="Color scheme"
          description="Sync with the OS or force light/dark across the dashboard."
          control={
            <div class="inline-flex gap-1.5">
              <For
                each={[
                  { value: "light" as const, label: "Light" },
                  { value: "dark" as const, label: "Dark" },
                  { value: "system" as const, label: "System" },
                ]}
              >
                {(option) => (
                  <Button
                    size="sm"
                    variant={theme() === option.value ? "default" : "outline"}
                    onClick={() => void handleThemeChange(option.value)}
                    disabled={pending() === option.value}
                  >
                    {option.label}
                  </Button>
                )}
              </For>
            </div>
          }
        />
      </SettingSection>
    </Card>
  );
}

function LayoutSection(): JSX.Element {
  return (
    <Card density="comfortable" className="settings-slide-down">
      <CardHeader title="Layout" sub="Shell configuration" />
      <SettingSection title="Navigation">
        <SettingRow
          label="Collapse sidebar by default"
          description="Sidebar starts collapsed on wide screens; user can still toggle it."
          control={
            <Switch
              checked={sidebarCollapsed()}
              onChange={setSidebarCollapsed}
              label="Collapse sidebar by default"
            />
          }
        />
      </SettingSection>
    </Card>
  );
}

interface APIKeysSectionProps {
  keys: readonly APIKeyRecord[];
  creating: boolean;
  busyKeyId: string | null;
  onCreate: (input: { label: string; scope: string }) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onToggle: (id: string, active: boolean) => Promise<void>;
}

function APIKeysSection(props: APIKeysSectionProps): JSX.Element {
  const disabledWhileBusy = (): boolean => props.busyKeyId !== null;
  return (
    <Card density="comfortable" className="settings-slide-down">
      <CardHeader title="API keys" sub={`${props.keys.length} active · managed via console PATCH`} />
      <SettingSection title="Manage keys">
        <Label>Keys</Label>
        <APIKeyManager
          keys={props.keys}
          creating={props.creating}
          onCreate={props.onCreate}
          onRevoke={disabledWhileBusy() ? undefined : props.onRevoke}
          onToggle={disabledWhileBusy() ? undefined : props.onToggle}
        />
      </SettingSection>
    </Card>
  );
}

function Row(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex items-center justify-between gap-3">
      <dt class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">{props.label}</dt>
      <dd class="font-mono text-[11.5px] text-[var(--text-1)]">{props.value}</dd>
    </div>
  );
}
