/** Tool icon — maps CLI tool IDs to provider icon assets in /providers/. */

import { useState, type ComponentType } from "react";
import { cn } from "../../../lib/cn";

/** Asset mapping for tools that have icons in /providers/. */
const TOOL_ICONS: Record<string, { file: string; ext: "svg" | "webp" }> = {
  claude: { file: "claude-code", ext: "svg" },
  codex: { file: "codex", ext: "webp" },
  cline: { file: "cline", ext: "webp" },
  opencode: { file: "opencode", ext: "webp" },
  droid: { file: "droid", ext: "webp" },
  hermes: { file: "hermes", ext: "webp" },
  "grok-build": { file: "grok", ext: "svg" },
  copilot: { file: "copilot", ext: "webp" },
  "deepseek-tui": { file: "deepseek-tui", ext: "webp" },
  jcode: { file: "jcode", ext: "webp" },
  kilo: { file: "kilocode", ext: "webp" },
  openclaw: { file: "openclaw", ext: "webp" },
  cowork: { file: "claude", ext: "webp" },
  cursor: { file: "cursor", ext: "webp" },
  roo: { file: "roo", ext: "webp" },
  continue: { file: "continue", ext: "webp" },
  amp: { file: "amp", ext: "webp" },
  qwen: { file: "qwen", ext: "webp" },
};

const failedIcons = new Set<string>();

function initialsOf(name: string): string {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ToolIcon({
  toolId,
  name,
  size = 32,
  className,
}: {
  toolId: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => failedIcons.has(toolId));
  const asset = TOOL_ICONS[toolId];

  if (!asset || failed) {
  return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg",
          className,
        )}
        role="img"
        aria-label={`${name} icon`}
        style={{ width: size, height: size }}
      >
        <span className="text-[11px] font-bold text-[var(--text-2)]">{initialsOf(name)}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        className,
      )}
      role="img"
      aria-label={`${name} icon`}
      style={{ width: size, height: size }}
    >
      <img
        src={`${import.meta.env.BASE_URL}providers/${asset.file}.${asset.ext}`}
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        onError={() => {
          failedIcons.add(toolId);
          setFailed(true);
        }}
      />
    </div>
  );
}

// Re-export for convenience — avoids unused import lint when only the type is used.
export type { ComponentType };
