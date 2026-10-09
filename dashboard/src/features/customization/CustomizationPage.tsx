/**
 * Customization — the console's cosmetic layer.
 *
 * Everything on this page writes through `saveCustomizationSettings`, which
 * mirrors the value onto `<html>` immediately, so the shell behind this page
 * is the preview. There is no separate preview pane and no apply button: what
 * you drag is what the console looks like.
 */

import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { Frame, Image as ImageIcon, Layers, PanelTop, RectangleHorizontal, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stack } from "../../components/ui/stack";
import {
  DEFAULT_BACKGROUND_URL,
  BACKGROUND_MAX_BYTES,
  BACKGROUND_WARN_BYTES,
  deleteBackgroundMedia,
  mediaKind,
  readBackgroundMedia,
  shrinkBackgroundImage,
  writeBackgroundMedia,
} from "./media";
import {
  BLUR_TARGET_ORDER,
  CUSTOMIZATION_DEFAULTS,
  saveCustomizationSettings,
  useCustomizationSettings,
  type BlurTarget,
  type CustomizationSettings,
} from "./settings";


const BLUR_TARGET_COPY: Record<BlurTarget, { readonly label: string; readonly description: string; readonly icon: ReactNode }> = {
  cards: {
    label: "Cards",
    description: "The card body on every page",
    icon: <RectangleHorizontal size={15} />,
  },
  chrome: {
    label: "Sidebar & topbar",
    description: "The shell around the page",
    icon: <PanelTop size={15} />,
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CustomizationPage(): ReactNode {
  const [settings, setSettings] = useCustomizationSettings();
  const [busy, setBusy] = useState(false);
  const [mediaBytes, setMediaBytes] = useState<number | null>(null);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const kind = mediaKind(file);
    if (!kind) {
      toast.error("Choose an image or a video.");
      return;
    }
    if (file.size > BACKGROUND_MAX_BYTES) {
      toast.error("File too big. 4 GB is the limit.");
      return;
    }
    const heavy = file.size > BACKGROUND_WARN_BYTES;
    setBusy(true);
    try {
      const blob = kind === "image" ? await shrinkBackgroundImage(file) : file;
      await writeBackgroundMedia(blob, kind);
      setMediaBytes(blob.size);
      setSettings({ backgroundSet: true, backgroundEnabled: true, backgroundRevision: settings.backgroundRevision + 1 });
      toast.success(kind === "video" ? "Video background saved in this browser." : "Background saved in this browser.");
      if (heavy) {
        toast.warning("File too big. Your web performance and experience may be degraded.");
      }
    } catch {
      toast.error("Could not store that file. The browser may be out of space.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteBackgroundMedia();
      setMediaBytes(null);
      setSettings({ backgroundSet: false, backgroundEnabled: false });
    } catch {
      toast.error("Could not remove the background.");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    // The stored file is kept; only the framing returns to the defaults.
    saveCustomizationSettings({
      backgroundOpacity: CUSTOMIZATION_DEFAULTS.backgroundOpacity,
      backgroundScale: CUSTOMIZATION_DEFAULTS.backgroundScale,
      backgroundX: CUSTOMIZATION_DEFAULTS.backgroundX,
      backgroundY: CUSTOMIZATION_DEFAULTS.backgroundY,
      backgroundBlur: CUSTOMIZATION_DEFAULTS.backgroundBlur,
      backgroundEnabled: settings.backgroundSet,
    });
    toast.success("Background reset to defaults.");
  };

  const resetBlur = () => {
    saveCustomizationSettings({
      blurCardsAmount: CUSTOMIZATION_DEFAULTS.blurCardsAmount,
      blurChromeAmount: CUSTOMIZATION_DEFAULTS.blurChromeAmount,
      blurCardsEnabled: CUSTOMIZATION_DEFAULTS.blurCardsEnabled,
      blurChromeEnabled: CUSTOMIZATION_DEFAULTS.blurChromeEnabled,
      blurCardsDepth: CUSTOMIZATION_DEFAULTS.blurCardsDepth,
      blurChromeDepth: CUSTOMIZATION_DEFAULTS.blurChromeDepth,
    });
    toast.success("Blur reset to defaults.");
  };

  return (
    <Stack gap="16px">
      <Card>
        <CardHeader
          title="Background"
          subtitle="Stored in this browser only. It never leaves the machine."
          icon={<ImageIcon size={16} />}
        />
        <CardBody>
          <Stack gap="14px">
            <BackgroundPreview settings={settings} onBytes={setMediaBytes} bytes={mediaBytes} />
            <div className="flex flex-wrap items-center gap-[8px]">
              <label className="btn btn-primary inline-flex items-center justify-center gap-[7px] rounded-control font-semibold text-[12.5px] px-[14px] py-2 cursor-pointer bg-accent text-accent-foreground">
                {busy ? "Working…" : settings.backgroundSet ? "Replace" : "Upload image or video"}
                <input
                  type="file"
                  accept="image/*,video/*"
                  className="sr-only"
                  onChange={(event) => void upload(event)}
                  disabled={busy}
                />
              </label>
              {settings.backgroundSet ? (
                <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy}>
                  Remove
                </Button>
              ) : null}
              <span className="text-[11.5px] text-text-tertiary">
                Images are resized to 2560px. Videos play on desktop and show their first frame on mobile.
              </span>
            </div>
            <BackgroundControls settings={settings} setSettings={setSettings} onReset={reset} />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Blur"
          subtitle="Each surface keeps its own style. Dialogs are never blurred, so they stay readable."
          icon={<Layers size={16} />}
          action={
            <Button variant="ghost" size="sm" icon={<RotateCcw size={13} />} onClick={resetBlur}>
              Reset
            </Button>
          }
        />
        <CardBody>
          <div className="grid gap-[20px] lg:grid-cols-2">
            {BLUR_TARGET_ORDER.map((target) => {
              const chrome = target === "chrome";
              return (
                <BlurSlider
                  key={target}
                  target={target}
                  enabled={chrome ? settings.blurChromeEnabled : settings.blurCardsEnabled}
                  onToggle={() =>
                    setSettings(chrome ? { blurChromeEnabled: !settings.blurChromeEnabled } : { blurCardsEnabled: !settings.blurCardsEnabled })
                  }
                  clarity={chrome ? settings.blurChromeAmount : settings.blurCardsAmount}
                  onClarity={(amount) => setSettings(chrome ? { blurChromeAmount: amount } : { blurCardsAmount: amount })}
                  depth={chrome ? settings.blurChromeDepth : settings.blurCardsDepth}
                  onDepth={(amount) => setSettings(chrome ? { blurChromeDepth: amount } : { blurCardsDepth: amount })}
                />
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Empty panels"
          subtitle="A dashed frame around a page that has nothing to show yet."
          icon={<Frame size={16} />}
        />
        <CardBody>
          <button
            type="button"
            role="switch"
            aria-checked={settings.emptyOutline}
            onClick={() => setSettings({ emptyOutline: !settings.emptyOutline })}
            className="flex w-full items-center justify-between gap-[12px] rounded-card border border-inner-border bg-surface-2 px-[14px] py-[12px] text-left"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-[12.5px] font-semibold text-text-primary">Dashed border</span>
              <span className="text-[11px] text-text-tertiary">Off leaves the empty state sitting on the card.</span>
            </span>
            <span
              aria-hidden="true"
              className={
                settings.emptyOutline
                  ? "h-[20px] w-[36px] shrink-0 rounded-pill bg-accent p-[2px]"
                  : "h-[20px] w-[36px] shrink-0 rounded-pill bg-surface-active p-[2px]"
              }
            >
              <span
                className={
                  settings.emptyOutline
                    ? "block size-[16px] translate-x-[16px] rounded-pill bg-accent-foreground transition-transform"
                    : "block size-[16px] rounded-pill bg-text-secondary transition-transform"
                }
              />
            </span>
          </button>
        </CardBody>
      </Card>
    </Stack>
  );
}
function BackgroundPreview({
  settings,
  bytes,
  onBytes,
}: {
  readonly settings: CustomizationSettings;
  readonly bytes: number | null;
  readonly onBytes: (bytes: number) => void;
}): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<"image" | "video" | null>(null);

  useEffect(() => {
    if (!settings.backgroundSet) {
      setUrl(DEFAULT_BACKGROUND_URL);
      setKind("image");
      return;
    }
    let active = true;
    let created: string | null = null;
    void readBackgroundMedia()
      .then((media) => {
        if (!media) return;
        if (!active) {
          URL.revokeObjectURL(media.url);
          return;
        }
        created = media.url;
        setUrl(media.url);
        setKind(media.kind);
        onBytes(media.blob.size);
      })
      .catch(() => {
        // The preview is decorative; the controls still work without it.
      });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [settings.backgroundSet, onBytes]);

  if (!url) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-card border border-dashed border-inner-border bg-surface-2 text-[12px] text-text-tertiary">
        No background yet. The console uses its plain surface.
      </div>
    );
  }

  const frame = {
    objectFit: "cover" as const,
    objectPosition: `${50 + settings.backgroundX / 2}% ${50 + settings.backgroundY / 2}%`,
    transform: `scale(${settings.backgroundScale / 100})`,
    opacity: settings.backgroundOpacity / 100,
  };
  return (
    <div className="relative h-[150px] overflow-hidden rounded-card border border-inner-border bg-surface-2">
      {kind === "video" ? (
        <video src={url} muted playsInline preload="metadata" className="size-full" style={frame} />
      ) : (
        <img src={url} alt="" className="size-full" style={frame} />
      )}
      <span className="absolute bottom-[8px] left-[10px] rounded-control bg-surface-1 px-[8px] py-[2px] text-[10.5px] text-text-secondary">
        {kind === "video" ? "Video" : "Image"}
        {bytes !== null ? ` · ${formatBytes(bytes)}` : ""}
        {settings.backgroundEnabled ? "" : " · hidden"}
      </span>
    </div>
  );
}

function BackgroundControls({
  settings,
  setSettings,
  onReset,
}: {
  readonly settings: CustomizationSettings;
  readonly setSettings: (patch: Partial<CustomizationSettings>) => void;
  readonly onReset: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="grid gap-[14px] sm:grid-cols-2">
        {settings.backgroundSet ? (
          <label className="flex items-center justify-between gap-[8px] text-[12px] text-text-secondary sm:col-span-2">
            <span>Show background</span>
            <input
              type="checkbox"
              checked={settings.backgroundEnabled}
              onChange={(event) => setSettings({ backgroundEnabled: event.target.checked })}
            />
          </label>
        ) : null}
        <Slider label="Visibility" value={settings.backgroundOpacity} defaultValue={CUSTOMIZATION_DEFAULTS.backgroundOpacity} min={0} max={100} unit="%" onChange={(value) => setSettings({ backgroundOpacity: value })} />
        <Slider label="Blur" value={settings.backgroundBlur} defaultValue={CUSTOMIZATION_DEFAULTS.backgroundBlur} min={0} max={100} unit="%" onChange={(value) => setSettings({ backgroundBlur: value })} />
        <Slider label="Zoom" value={settings.backgroundScale} defaultValue={CUSTOMIZATION_DEFAULTS.backgroundScale} min={100} max={180} unit="%" onChange={(value) => setSettings({ backgroundScale: value })} />
        <Slider label="Shift horizontal" value={settings.backgroundX} defaultValue={CUSTOMIZATION_DEFAULTS.backgroundX} min={-100} max={100} onChange={(value) => setSettings({ backgroundX: value })} />
        <Slider label="Shift vertical" value={settings.backgroundY} defaultValue={CUSTOMIZATION_DEFAULTS.backgroundY} min={-100} max={100} onChange={(value) => setSettings({ backgroundY: value })} />
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" icon={<RotateCcw size={13} />} onClick={onReset}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  defaultValue,
  min,
  max,
  unit,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly onChange: (value: number) => void;
}): ReactNode {
  return (
    <label className="flex flex-col gap-[4px] text-[12px] text-text-secondary">
      <span className="flex items-center justify-between">
        {label}
        <span className="flex items-center gap-[6px]">
          <span className="font-mono tabular-nums text-[11px] text-text-tertiary">
            {value}
            {unit ?? ""}
          </span>
          <button
            type="button"
            onClick={() => onChange(defaultValue)}
            disabled={value === defaultValue}
            aria-label={`Reset ${label}`}
            title={`Reset ${label} to ${defaultValue}${unit ?? ""}`}
            className="flex size-[18px] items-center justify-center rounded-control text-text-tertiary hover:bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
          >
            <RotateCcw size={11} />
          </button>
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="blur-slider w-full"
        style={{ ["--fill" as string]: `${((value - min) / (max - min)) * 100}%` }}
      />
    </label>
  );
}

function BlurSlider({
  target,
  enabled,
  onToggle,
  clarity,
  onClarity,
  depth,
  onDepth,
}: {
  readonly target: BlurTarget;
  readonly enabled: boolean;
  readonly onToggle: () => void;
  readonly clarity: number;
  readonly onClarity: (amount: number) => void;
  readonly depth: number;
  readonly onDepth: (amount: number) => void;
}): ReactNode {
  const item = BLUR_TARGET_COPY[target] ?? BLUR_TARGET_COPY.cards;
  return (
    <div className="flex flex-col gap-[16px] rounded-card border border-inner-border bg-surface-2 p-[16px]">
      <div className="flex items-center gap-[10px]">
        <span className="flex size-[32px] shrink-0 items-center justify-center rounded-control bg-surface-1 text-text-secondary">
          {item.icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold text-text-primary">{item.label}</span>
          <span className="text-[11.5px] text-text-tertiary">{item.description}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Toggle ${item.label} blur`}
          onClick={onToggle}
          className={enabled ? "h-[20px] w-[36px] shrink-0 rounded-pill bg-accent p-[2px]" : "h-[20px] w-[36px] shrink-0 rounded-pill bg-surface-active p-[2px]"}
        >
          <span className={enabled ? "block size-[16px] translate-x-[16px] rounded-pill bg-accent-foreground" : "block size-[16px] rounded-pill bg-text-secondary"} />
        </button>
      </div>
      <div className={enabled ? "flex flex-col gap-[12px]" : "flex flex-col gap-[12px] opacity-40"}>
        <label className="flex flex-col gap-[6px] text-[12px] text-text-secondary">
          <span className="flex items-center justify-between">
            Clarity
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{clarity}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={clarity}
            disabled={!enabled}
            onChange={(event) => onClarity(Number(event.target.value))}
            aria-label={`${item.label} clarity. How see-through the surface is.`}
            className="blur-slider w-full"
            style={{ ["--fill" as string]: `${clarity}%` }}
          />
          <span className="flex justify-between text-[11px] text-text-tertiary">
            <span>See-through</span>
            <span>Solid</span>
          </span>
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-text-secondary">
          <span className="flex items-center justify-between">
            Blur
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{depth}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={depth}
            disabled={!enabled}
            onChange={(event) => onDepth(Number(event.target.value))}
            aria-label={`${item.label} blur. How blurred whatever is behind it looks.`}
            className="blur-slider w-full"
            style={{ ["--fill" as string]: `${depth}%` }}
          />
          <span className="flex justify-between text-[11px] text-text-tertiary">
            <span>Sharp</span>
            <span>Blurred</span>
          </span>
        </label>
      </div>
    </div>
  );
}
