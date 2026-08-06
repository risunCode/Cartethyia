/** Tool icon — maps CLI tool IDs to provider icon assets in /providers/. */

import { useState, type ComponentType } from "react";
import { cn } from "../../../lib/cn";

/** Asset mapping for tools that have icons in /providers/. */
const TOOL_ICONS: Record<string, { file: string; ext: "svg" | "png" }> = {
  claude: { file: "claude-code", ext: "svg" },
  codex: { file: "codex", ext: "png" },
  cline: { file: "cline", ext: "png" },
  opencode: { file: "opencode", ext: "png" },
  droid: { file: "droid", ext: "png" },
  hermes: { file: "hermes", ext: "png" },
  "grok-build": { file: "grok", ext: "svg" },
  copilot: { file: "copilot", ext: "png" },
  "deepseek-tui": { file: "deepseek-tui", ext: "png" },
  jcode: { file: "jcode", ext: "png" },
  kilo: { file: "kilocode", ext: "png" },
  openclaw: { file: "openclaw", ext: "png" },
  cowork: { file: "claude", ext: "png" },
  cursor: { file: "cursor", ext: "png" },
  roo: { file: "roo", ext: "png" },
  continue: { file: "continue", ext: "png" },
  amp: { file: "amp", ext: "png" },
  qwen: { file: "qwen", ext: "png" },
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
