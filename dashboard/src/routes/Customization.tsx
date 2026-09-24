import {
  Image as ImageIcon,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button";
import { formatBytes } from "../lib/format";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { Slider } from "../components/ui/slider";
import { Switch } from "../components/ui/switch";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { useDebouncedSave } from "../lib/use-debounced-save";
import {
  classifyCustomAssetFile,
  MAX_BRANDING_ASSET_BYTES,
  MAX_CUSTOM_ASSET_BYTES,
  saveCustomizationSettings,
  useCustomizationAssetUrl,
  useCustomizationBranding,
  useCustomizationSettings,
  readCustomizationSettings,
} from "../lib/customization";

const BRANDING_MIME_OK: Record<string, true> = { "image/png": true, "image/gif": true };

function BrandingCard(): ReactNode {
  const [branding, setBranding] = useCustomizationBranding();
  const [dragging, setDragging] = useState(false);
  const [brandingError, setBrandingError] = useState<string | null>(null);
  const brandingInputRef = useRef<HTMLInputElement>(null);

  const acceptBrandingFile = (file: File) => {
    if (!BRANDING_MIME_OK[file.type]) {
      setBrandingError("Branding icon must be PNG or GIF.");
      return;
    }
    if (file.size > MAX_BRANDING_ASSET_BYTES) {
      setBrandingError(`Branding icon exceeds the ${formatBytes(MAX_BRANDING_ASSET_BYTES)} limit.`);
      return;
    }
    setBranding({ asset: { kind: "image", blob: file, name: file.name } });
    setBrandingError(null);
  };

  const handleBrandingFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) acceptBrandingFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) acceptBrandingFile(file);
  };

  return (
    <Card>
      <CardHeader
        title="Branding Icon"
        subtitle="Local console badge — PNG or GIF, ≤25 MB"
        icon={<ImageIcon size={16} />}
      />
      <CardBody>
        <div
          className={`branding-dropzone${dragging ? " branding-dropzone-active" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Branding icon dropzone. Press Enter to choose a PNG or GIF file."
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              brandingInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          style={{
            borderRadius: "10px",
            border: `1px dashed ${dragging ? "var(--accent)" : "var(--inner-border)"}`,
            background: dragging ? "var(--accent-soft)" : "var(--surface-2)",
            padding: "12px",
            transition: "opacity var(--dur-micro) var(--ease-spring), background-color var(--dur-micro) var(--ease-spring)",
          }}
        >
          {branding.asset ? (
            <Inline gap="8px">
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: "var(--surface-1)",
                  border: "1px solid var(--inner-border)",
                  display: "grid",
                  placeItems: "center",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <BrandingPreview asset={branding.asset} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {branding.asset.name}
                </div>
                <div style={{ fontSize: "10.5px", color: "var(--text-tertiary)" }}>
                  PNG/GIF • local
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBranding({ asset: null })}
                icon={<Trash2 size={14} />}
              >
                Remove
              </Button>
            </Inline>
          ) : (
            <Inline gap="10px">
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: "var(--surface-1)",
                  border: "1px solid var(--inner-border)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-tertiary)",
                  flexShrink: 0,
                }}
              >
                <ImageIcon size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "12px", fontWeight: 600 }}>Drop PNG/GIF here</div>
                <div style={{ fontSize: "10.5px", color: "var(--text-tertiary)" }}>
                  Local console badge
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => brandingInputRef.current?.click()}
                icon={<Upload size={14} />}
              >
                Choose
              </Button>
            </Inline>
          )}
          <input
            ref={brandingInputRef}
            hidden
            type="file"
            accept="image/png,image/gif"
            onChange={handleBrandingFile}
          />
        </div>
        {brandingError ? (
          <p className="form-error" role="alert" style={{ marginTop: "10px" }}>
            {brandingError}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function BrandingPreview({
  asset,
}: {
  readonly asset: { readonly kind: string; readonly blob: Blob };
}): ReactNode {
  const url = useCustomizationAssetUrl({ kind: "image", blob: asset.blob, name: "branding" });
  if (!url) return null;
  return (
    <img
      src={url}
      alt="Branding icon preview"
      style={{ width: "40px", height: "40px", objectFit: "contain", borderRadius: "8px" }}
    />
  );
}

function BackgroundControls(): ReactNode {
  const [settings, setSettings] = useCustomizationSettings();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Sliders update this local state on every drag pixel for instant visual
  // feedback; the actual settings commit (DOM/event/IDB write fan-out) is
  // debounced so a drag doesn't fire ~100 app-wide re-renders.
  const [liveOpacity, setLiveOpacity] = useState(settings.backgroundOpacity);
  const [liveBlur, setLiveBlur] = useState(settings.backgroundBlur);
  useEffect(() => setLiveOpacity(settings.backgroundOpacity), [settings.backgroundOpacity]);
  useEffect(() => setLiveBlur(settings.backgroundBlur), [settings.backgroundBlur]);
  const saveOpacity = useDebouncedSave<number>((backgroundOpacity) =>
    setSettings({ backgroundOpacity }),
  );
  const saveBlur = useDebouncedSave<number>((backgroundBlur) => setSettings({ backgroundBlur }));

  const acceptFile = (file: File) => {
    const kind = classifyCustomAssetFile(file);
    if (!kind) {
      setError("Choose an image or video file.");
      return;
    }
    if (file.size > MAX_CUSTOM_ASSET_BYTES) {
      setError(`Media exceeds the ${formatBytes(MAX_CUSTOM_ASSET_BYTES)} limit.`);
      return;
    }
    setSettings({
      backgroundAsset: { kind, blob: file, name: file.name },
      backgroundEnabled: true,
    });
    setError(null);
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) acceptFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  };

  return (
    <Card>
      <CardHeader
        title="Custom Background"
        subtitle="Stored only in this browser — image or video"
        icon={<Upload size={16} />}
      />
      <CardBody>
        <Stack gap="14px">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div>
              <div style={{ fontSize: "13px", fontWeight: 600 }}>Enable background</div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                {settings.backgroundAsset ? settings.backgroundAsset.name : "No file selected"}
              </div>
            </div>
            <Switch
              checked={settings.backgroundEnabled}
              onChange={(backgroundEnabled) => setSettings({ backgroundEnabled })}
              label="Enable background"
            />
          </div>
          <div
            role="button"
            tabIndex={0}
            aria-label="Custom background dropzone. Press Enter to choose an image or video file."
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              borderRadius: "10px",
              border: `1px dashed ${dragging ? "var(--accent)" : "var(--inner-border)"}`,
              background: dragging ? "var(--accent-soft)" : "var(--surface-2)",
              padding: "12px",
              transition: "opacity var(--dur-micro) var(--ease-spring), background-color var(--dur-micro) var(--ease-spring)",
            }}
          >
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                background: "var(--surface-1)",
                border: "1px solid var(--inner-border)",
                display: "grid",
                placeItems: "center",
                color: "var(--text-tertiary)",
                flexShrink: 0,
              }}
            >
              <Upload size={16} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {settings.backgroundAsset
                  ? settings.backgroundAsset.name
                  : "Drop image or video here"}
              </div>
              <div style={{ fontSize: "10.5px", color: "var(--text-tertiary)" }}>
                {settings.backgroundAsset
                  ? `${settings.backgroundAsset.kind === "video" ? "Video" : "Image"} • local only`
                  : "MP4, WebM, OGV, MOV or any image"}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => inputRef.current?.click()}
              icon={<Upload size={14} />}
            >
              {settings.backgroundAsset ? "Change" : "Choose"}
            </Button>
            {settings.backgroundAsset ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSettings({ backgroundAsset: null, backgroundEnabled: false })}
                icon={<Trash2 size={14} />}
              >
                Remove
              </Button>
            ) : null}
            <input
              ref={inputRef}
              hidden
              type="file"
              accept="image/*,video/*,.mp4,.webm,.ogv,.mov"
              onChange={handleFile}
            />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div
            style={{
              display: "grid",
              gap: "14px",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            }}
          >
            <Slider
              label="Background opacity (%)"
              min={0}
              max={100}
              value={liveOpacity}
              onValueChange={(value) => {
                setLiveOpacity(value);
                saveOpacity(value);
              }}
            />
            <Slider
              label="Blur"
              min={0}
              max={18}
              value={liveBlur}
              onValueChange={(value) => {
                setLiveBlur(value);
                saveBlur(value);
              }}
            />
          </div>
        </Stack>
      </CardBody>
    </Card>
  );
}

export default function Customization(): ReactNode {
  const [settings, setSettings] = useCustomizationSettings();

  return (
    <Stack gap="16px">
      <div
        style={{
          borderRadius: "14px",
          border: "1px solid var(--inner-border)",
          background: "var(--surface-2)",
          padding: "16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "12px", alignItems: "center", minWidth: 0 }}>
          <span
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "10px",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <Palette size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: "14px", fontWeight: 700, letterSpacing: "-0.01em" }}>
              Personalize
            </h1>
            <p style={{ fontSize: "11.5px", color: "var(--text-tertiary)", marginTop: "1px" }}>
              Theme, glass, branding & background — stored locally in{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  background: "var(--surface-1)",
                  border: "1px solid var(--inner-border)",
                  padding: "1px 5px",
                  borderRadius: "6px",
                }}
              >
                console-db
              </code>
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            saveCustomizationSettings({
              backgroundAsset: null,
              backgroundEnabled: false,
              backgroundOpacity: 21,
              backgroundBlur: 2,
              glassEnabled: false,
              glassDepth: 1,
            });
            setSettings({ ...readCustomizationSettings() });
          }}
          icon={<RotateCcw size={14} />}
        >
          Reset atmosphere
        </Button>
      </div>

      <div className="two-column-grid">
        <Card>
          <CardHeader
            title="Appearance Mode"
            subtitle="System / Light / Dark — persisted locally"
            icon={<Palette size={16} />}
          />
          <CardBody>
            <div
              role="radiogroup"
              aria-label="Appearance mode"
              style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}
            >
              {(["system", "light", "dark"] as const).map((choice) => {
                const active = settings.theme === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSettings({ theme: choice })}
                    style={{
                      padding: "14px 10px",
                      borderRadius: "12px",
                      border: active ? "2px solid var(--accent)" : "1px solid var(--inner-border)",
                      background: active ? "var(--accent-soft)" : "var(--surface-2)",
                      textAlign: "center",
                      transition: "background-color var(--dur-micro) var(--ease-spring), border-color var(--dur-micro) var(--ease-spring), color var(--dur-micro) var(--ease-spring)",
                    }}
                  >
                    <span
                      style={{
                        display: "grid",
                        placeItems: "center",
                        color: active ? "var(--accent)" : "var(--text-secondary)",
                      }}
                    >
                      {choice === "dark" ? (
                        <Moon size={20} />
                      ) : choice === "light" ? (
                        <Sun size={20} />
                      ) : (
                        <Sparkles size={20} />
                      )}
                    </span>
                    <strong
                      style={{
                        display: "block",
                        fontSize: "12px",
                        marginTop: "8px",
                        color: active ? "var(--accent)" : "var(--text-primary)",
                      }}
                    >
                      {choice.toUpperCase()}
                    </strong>
                    <span
                      style={{
                        display: "block",
                        fontSize: "10px",
                        color: "var(--text-tertiary)",
                        marginTop: "2px",
                      }}
                    >
                      {choice === "system"
                        ? "Follow OS"
                        : choice === "dark"
                          ? "Always dark"
                          : "Always light"}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Glass Surfaces"
            subtitle="Depth treatment for cards & modals"
            icon={<Sparkles size={16} />}
          />
          <CardBody>
            <Stack gap="14px">
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
                  <div style={{ fontSize: "12.5px", fontWeight: 600 }}>Enable glass mode</div>
                  <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                    Translucent depth with backdrop blur
                  </div>
                </div>
                <Switch
                  checked={settings.glassEnabled}
                  onChange={(glassEnabled) => setSettings({ glassEnabled })}
                  label="Enable glass mode"
                />
              </div>
              {settings.glassEnabled ? (
                <Select
                  label="Glass depth"
                  id="glass-depth"
                  value={String(settings.glassDepth)}
                  onValueChange={(value) => setSettings({ glassDepth: value === "2" ? 2 : 1 })}
                  options={[
                    { value: "1", label: "Depth 1 — subtle" },
                    { value: "2", label: "Depth 2 — strong" },
                  ]}
                />
              ) : (
                <p style={{ fontSize: "11px", color: "var(--text-tertiary)", padding: "2px 2px" }}>
                  Turn on glass to choose depth. Works best with a background image.
                </p>
              )}
            </Stack>
          </CardBody>
        </Card>
      </div>

      <div className="two-column-grid">
        <BrandingCard />
        <BackgroundControls />
      </div>
      <p style={{ fontSize: "11px", color: "var(--text-tertiary)", textAlign: "center" }}>
        Background files are limited to {formatBytes(MAX_CUSTOM_ASSET_BYTES)}. Branding & background
        never leave this browser.
      </p>
    </Stack>
  );
}
