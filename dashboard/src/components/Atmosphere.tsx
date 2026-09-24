import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useCustomizationAssetUrl, useCustomizationSettings } from "../lib/customization";

const DEFAULT_BACKGROUND_URL = `${import.meta.env.BASE_URL}default-backgrounds.webp`;

export function Atmosphere(): ReactNode {
  const [settings] = useCustomizationSettings();
  const assetUrl = useCustomizationAssetUrl(settings.backgroundAsset);
  const backgroundUrl = settings.backgroundAsset ? assetUrl : DEFAULT_BACKGROUND_URL;

  useEffect(() => {
    const root = document.documentElement;
    if (settings.glassEnabled) {
      root.dataset.glassEnabled = "true";
      root.dataset.glassDepth = String(settings.glassDepth);
    } else {
      delete root.dataset.glassEnabled;
      delete root.dataset.glassDepth;
    }
  }, [settings.glassDepth, settings.glassEnabled]);

  if (!settings.backgroundEnabled || !backgroundUrl) return null;
  const style: CSSProperties = {
    opacity: settings.backgroundOpacity / 100,
    ["--custom-bg-blur" as string]: `${settings.backgroundBlur}px`,
  };
  if (settings.backgroundAsset?.kind === "video") {
    return (
      <video
        className="custom-background-layer"
        src={backgroundUrl}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        tabIndex={-1}
        aria-hidden="true"
        style={style}
      />
    );
  }
  return (
    <img
      className="custom-background-layer"
      src={backgroundUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={style}
    />
  );
}
