/**
 * Provider brand icon with a text fallback.
 *
 * Not every provider ships an icon asset, and a missing file must not leave a
 * blank square or retry the same 404 on every mount. The first failure for an
 * icon id is remembered for the session so later mounts render the fallback
 * immediately.
 */

import { useState } from "react";
import { cn } from "../lib/cn";

const failedIcons = new Set<string>();
const iconAssets: Record<string, { file: string; ext: "svg" | "png" }> = {
  claude: { file: "claude-code", ext: "svg" },
  opencodeft: { file: "opencode", ext: "png" },
  opencodezen: { file: "opencode", ext: "png" },
  opencodego: { file: "opencode-go", ext: "png" },
  "google-antigravity": { file: "antigravity", ext: "svg" },
  antigravity: { file: "antigravity", ext: "svg" },
  blackbox: { file: "blackbox", ext: "svg" },
  blackboxai: { file: "blackbox", ext: "svg" },
  grok: { file: "grok", ext: "svg" },
  "grok-build": { file: "grok-build", ext: "svg" },
};

function assetFor(icon: string): { file: string; ext: "svg" | "png" } {
  return iconAssets[icon] ?? { file: icon, ext: "png" };
}

/** Derives the two-letter fallback shown when no icon asset resolves. */
function initialsOf(name: string): string {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProviderIcon({
  icon,
  name,
  size = 32,
  className,
}: {
  icon: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => failedIcons.has(icon));

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-muted)]",
        className
      )}
      role="img"
      aria-label={`${name} provider`}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span aria-hidden="true" className="text-[11px] font-bold tracking-tight text-[var(--text-secondary)]">{initialsOf(name)}</span>
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}providers/${assetFor(icon).file}.${assetFor(icon).ext}`}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
          onError={() => {
            failedIcons.add(icon);
            setFailed(true);
          }}
        />
      )}
    </div>
  );
}
