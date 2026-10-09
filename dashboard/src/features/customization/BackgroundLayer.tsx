/**
 * The fixed layer behind the shell.
 *
 * One element, always mounted while a background is stored, so toggling it on
 * does not re-decode the blob. Framing (zoom and anchor) comes from the CSS
 * variables `applyCustomization` sets on `<html>`; this component only decides
 * whether anything renders and which element renders it.
 *
 * Video is the expensive case, so it degrades on purpose: a narrow viewport
 * pauses it and shows its first frame, a hidden tab pauses it, and
 * `prefers-reduced-motion` never plays it. The image path has none of that
 * cost and always renders.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_BACKGROUND_URL, readBackgroundMedia, type BackgroundMedia } from "./media";
import { useCustomizationSettings } from "./settings";

const COMPACT_QUERY = "(max-width: 767px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

export function BackgroundLayer(): ReactNode {
  const [settings] = useCustomizationSettings();
  const [media, setMedia] = useState<BackgroundMedia | null>(null);
  const compact = useMediaQuery(COMPACT_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!settings.backgroundSet) {
      setMedia((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { blob: new Blob(), kind: "image", url: DEFAULT_BACKGROUND_URL };
      });
      return;
    }
    let revoked = false;
    let loaded: BackgroundMedia | null = null;
    void readBackgroundMedia()
      .then((next) => {
        if (revoked) {
          if (next) URL.revokeObjectURL(next.url);
          return;
        }
        loaded = next;
        setMedia(next);
      })
      .catch(() => {
        if (!revoked) setMedia(null);
      });
    return () => {
      revoked = true;
      if (loaded) URL.revokeObjectURL(loaded.url);
    };
  }, [settings.backgroundSet, settings.backgroundRevision]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playVideo = media?.kind === "video" && !compact && !reducedMotion && pageVisible;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playVideo) {
      void video.play().catch(() => {
        // Autoplay can still be refused; the poster frame stays up.
      });
      return;
    }
    video.pause();
  }, [playVideo]);

  if (!media || (settings.backgroundSet && !settings.backgroundEnabled)) return null;

  return (
    <div className="custom-background" data-kind={media.kind} data-playing={playVideo ? "true" : "false"} aria-hidden="true">
      {media.kind === "video" ? (
        <video
          ref={videoRef}
          className="custom-background-media"
          src={media.url}
          autoPlay={playVideo}
          loop
          muted
          playsInline
          preload={compact ? "metadata" : "auto"}
        />
      ) : (
        <img className="custom-background-media" src={media.url} alt="" />
      )}
    </div>
  );
}
