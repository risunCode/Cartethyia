
import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { KeyRound, Server, Shield } from "lucide-solid";
import { Card, CardHeader } from "@components/ui/card";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { Badge, Skeleton } from "@components/ui/badge";
import { SettingRow, SettingSection } from "@components/patterns/setting-row";
import { glassSurfaces, setGlassSurfaces, setTheme, theme } from "@lib/store";
import { consoleFailure, consoleGet, consolePatch } from "@lib/console-api";

interface SettingsResponse {
  readonly theme?: string;
  readonly version?: string;
  readonly sidebarCollapsed?: boolean;
  readonly solidMode?: boolean;
  readonly performanceMode?: boolean;
  readonly notificationsEnabled?: boolean;
  readonly defaultModel?: string;
}

const SETTINGS_ENDPOINT = "/settings";

export default function Settings(): JSX.Element {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

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

  return (
    <div class="dashboard-page space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-bold text-[var(--text-1)]">Settings</h1>
          <p class="mt-1 text-[11px] text-[var(--text-2)]">
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
            <Skeleton className="h-20 rounded-[var(--radius-card)]" />
            <Skeleton className="h-16 rounded-[var(--radius-card)]" />
            <Skeleton className="h-24 rounded-[var(--radius-card)]" />
          </div>
        }
      >
        <AppearanceSection onThemePatch={(value) => patchSetting({ theme: value })} />
      </Show>

      <Card density="comfortable" class="settings-slide-down">
        <CardHeader title="Connection" icon={Server} iconColor="var(--accent)" sub="Daemon binding and version" />
        <dl class="grid gap-3 text-[12px] sm:grid-cols-2">
          <Detail label="Endpoint" value={`${window.location.origin}/v1`} />
          <Detail label="Version" value={settingsResource()?.version ?? "—"} />
          <Detail label="Status" value={settingsResource() ? "Connected" : "Unavailable"} />
        </dl>
      </Card>

      <Card density="comfortable" class="settings-slide-down">
        <CardHeader title="API keys" icon={Shield} iconColor="var(--status-warning)" sub="Operator credentials and access" />
        <Show
          when={settingsResource()?.defaultModel ?? false}
          fallback={
            <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--hover)] px-4 py-6 text-center">
              <span class="grid h-10 w-10 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                <KeyRound size={18} aria-hidden="true" />
              </span>
              <div>
                <p class="text-xs font-semibold text-[var(--text-1)]">No API keys configured</p>
                <p class="mt-0.5 text-[10px] text-[var(--text-3)]">
                  API key management will appear here once the /console/settings contract includes credential routes.
                </p>
              </div>
            </div>
          }
        >
          <dl class="grid gap-3 text-[12px] sm:grid-cols-2">
            <Detail label="Default model" value={settingsResource()?.defaultModel ?? "—"} />
            <Detail label="Notifications" value={settingsResource()?.notificationsEnabled ? "Enabled" : "Disabled"} />
          </dl>
        </Show>
      </Card>

      <Show when={error()}>
        {(message) => (
          <p class="text-[12px] text-[var(--status-danger)]" role="alert">
            {message()}
          </p>
        )}
      </Show>

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
      <SettingSection title="Surfaces">
        <SettingRow
          label="Glass surfaces"
          description="Translucent cards with a subtle backdrop blur (the classic look). Off by default; blur is confined to small cards, so it stays smooth even while scrolling."
          control={
            <Switch
              checked={glassSurfaces()}
              onChange={setGlassSurfaces}
              label="Glass surfaces"
            />
          }
        />
      </SettingSection>
    </Card>
  );
}

function Detail(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="min-w-0">
      <dt class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">{props.label}</dt>
      <dd class="mt-0.5 break-words text-[var(--text-1)]">{props.value}</dd>
    </div>
  );
}

