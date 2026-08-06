/** Customization — one compact, local custom background control. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Image as ImageIcon, SlidersHorizontal, Trash2, Upload, Gauge } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/shared";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../lib/toast";
import { apiGet, apiPost } from "../../lib/api";
import { BackgroundUpload, useCustomizationSettings } from "./background";

interface AppearanceSettings {
  sidebarIconDataUrl: string | null;
}

interface AppearanceSettingsResponse {
  settings: {
    runtime: AppearanceSettings;
  };
}

const DEFAULT_SIDEBAR_ICON_URL = `${import.meta.env.BASE_URL}favicon_love.webp`;
const MAX_SIDEBAR_ICON_BYTES = 25 * 1024 * 1024;
const SIDEBAR_ICON_TYPES = new Set(["image/png", "image/gif"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function CustomizationPage() {
  const [settings, setSettings] = useCustomizationSettings();
  const [error, setError] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const sidebarIconInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const asset = settings.backgroundAsset;
  const appearanceQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<AppearanceSettingsResponse>("/settings"),
  });
  const appearanceMutation = useMutation({
    mutationFn: (patch: Partial<AppearanceSettings>) => apiPost<{ ok: boolean }>("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update appearance settings"),
  });
  const appearance = appearanceQuery.data?.settings.runtime;

  const handleSidebarIconChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (file === null) return;
    if (!SIDEBAR_ICON_TYPES.has(file.type)) {
      toast.error("Sidebar icon must be a PNG or GIF file");
      return;
    }
    if (file.size > MAX_SIDEBAR_ICON_BYTES) {
      toast.error("Sidebar icon must be 25 MiB or smaller");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string" || !/^data:image\/(?:png|gif);base64,/.test(dataUrl)) {
        toast.error("Unable to read sidebar icon");
        return;
      }
      appearanceMutation.mutate({ sidebarIconDataUrl: dataUrl }, { onSuccess: () => toast.success("Sidebar icon updated") });
    };
    reader.onerror = () => toast.error("Unable to read sidebar icon");
    reader.readAsDataURL(file);
  };

  const resetSidebarIcon = () => {
    appearanceMutation.mutate({ sidebarIconDataUrl: null }, { onSuccess: () => toast.success("Sidebar icon reset") });
  };

  const reportError = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const applyReset = () => {
    setSettings({
      backgroundAsset: null,
      backgroundEnabled: true,
      backgroundOpacity: 21,
      backgroundBlur: 2,
      solidMode: false,
    });
    setError(null);
    toast.success("Customization reset.");
  };

  return (
    <div className="dashboard-page space-y-4">
      <Card density="compact" className="w-full">
        <CardHeader
          title="Custom background"
          icon={SlidersHorizontal}
          sub="Built-in by default; local overrides stay in this browser."
        >
          <Badge tone={asset ? "ok" : settings.backgroundEnabled ? "info" : "default"}>
            {asset ? "Override active" : settings.backgroundEnabled ? "Built-in" : "Disabled"}
          </Badge>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmResetOpen(true)} disabled={!asset && settings.backgroundEnabled && settings.backgroundOpacity === 21 && settings.backgroundBlur === 2}>
            <RotateCcw size={13} aria-hidden="true" />
            Reset
          </Button>
        </CardHeader>

        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
          <section className="min-w-0 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{asset?.name ?? "Built-in background"}</p>
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">
                  {asset ? `${asset.kind === "video" ? "Video" : "Image"} · ${formatBytes(asset.blob.size)} · Stored locally` : settings.backgroundEnabled ? "Default picture · Override it with your own image or video." : "Built-in picture disabled."}
                </p>
              </div>
              <Switch
                checked={settings.backgroundEnabled}
                onChange={(checked) => setSettings({ backgroundEnabled: checked })}
                label={asset ? "Enable custom background" : "Enable built-in background"}
              />
            </div>
            <div className="mt-3">
              <BackgroundUpload onError={reportError} />
            </div>
          </section>

          <section className="min-w-0 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3" aria-label="Background settings">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)]">
              <SlidersHorizontal size={13} aria-hidden="true" />
              Background settings
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="custom-background-opacity">Opacity</Label>
                  <span className="font-mono text-[10px] text-[var(--text-3)]">{settings.backgroundOpacity}%</span>
                </div>
                <Input
                  id="custom-background-opacity"
                  name="custom-background-opacity"
                  type="range"
                  min="8"
                  max="70"
                  value={settings.backgroundOpacity}
                  onChange={(event) => setSettings({ backgroundOpacity: Number(event.target.value) })}
                  className="h-1.5 cursor-pointer px-0 py-0 accent-[var(--accent)]"
                  aria-label="Custom background opacity"
                />
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="custom-background-blur">Blur</Label>
                  <span className="font-mono text-[10px] text-[var(--text-3)]">{settings.backgroundBlur}px</span>
                </div>
                <Input
                  id="custom-background-blur"
                  name="custom-background-blur"
                  type="range"
                  min="0"
                  max="18"
                  value={settings.backgroundBlur}
                  onChange={(event) => setSettings({ backgroundBlur: Number(event.target.value) })}
                  className="h-1.5 cursor-pointer px-0 py-0 accent-[var(--accent)]"
                  aria-label="Custom background blur"
                />
              </div>
            </div>
          </section>
        </div>

        {error && (
          <p role="alert" aria-live="polite" className="mt-3 rounded-lg border border-[var(--red)] bg-[var(--red-soft,rgba(255,69,58,0.1))] px-2.5 py-2 text-xs text-[var(--red)]">
            {error}
          </p>
        )}

        <ConfirmDialog
          open={confirmResetOpen}
          onClose={() => setConfirmResetOpen(false)}
          onConfirm={applyReset}
          title="Reset customization?"
          message="This clears the local override and restores the built-in background with default display settings."
          confirmLabel="Reset customization"
          danger
        />
      </Card>

      {appearance && (
        <>
        <Card density="compact" className="w-full">
          <CardHeader
            title="Performance Mode"
            icon={Gauge}
            sub="Disable blur effects and use solid warm surfaces for a smoother experience."
          >
            <Badge tone={settings.solidMode ? "ok" : "default"}>
              {settings.solidMode ? "Solid" : "Frosted"}
            </Badge>
          </CardHeader>
          <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold">Solid surfaces (no blur)</div>
              <div className="mt-0.5 text-[11px] text-[var(--text-3)]">
                Replaces frosted-glass backdrop-filter with solid black/white warm surfaces. Fixes lag on lower-end GPUs and saves ~20–40 MB RAM.
              </div>
            </div>
            <Switch
              checked={settings.solidMode}
              onChange={(checked) => setSettings({ solidMode: checked })}
              label="Solid mode"
            />
          </div>
        </Card>

        <Card density="compact" className="w-full">
          <CardHeader title="Application Appearance" icon={ImageIcon} sub="Customize the dashboard sidebar icon." />
          <div className="space-y-3">
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <img src={appearance.sidebarIconDataUrl ?? DEFAULT_SIDEBAR_ICON_URL} alt="Sidebar icon preview" className="h-12 w-12 shrink-0 rounded-xl border border-[var(--inner-border)] bg-[var(--surface)] object-cover" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold">Custom sidebar icon</div>
                  <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Upload a PNG or animated GIF up to 25 MiB.</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <input ref={sidebarIconInputRef} type="file" accept="image/png,image/gif" className="sr-only" onChange={handleSidebarIconChange} />
                <Button variant="secondary" size="sm" disabled={appearanceMutation.isPending} onClick={() => sidebarIconInputRef.current?.click()}>
                  <Upload size={13} /> {appearance.sidebarIconDataUrl ? "Change icon" : "Upload icon"}
                </Button>
                {appearance.sidebarIconDataUrl && (
                  <Button variant="ghost" size="sm" disabled={appearanceMutation.isPending} onClick={resetSidebarIcon}>
                    <Trash2 size={13} /> Reset
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Card>
        </>
      )}
    </div>
  );
}
