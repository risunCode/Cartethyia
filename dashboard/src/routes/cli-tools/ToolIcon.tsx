import { useState, type ReactNode } from "react";

const TOOL_ICONS: Record<string, { file: string; ext: "svg" | "webp" }> = {
  claude: { file: "claude-code", ext: "svg" },
  codex: { file: "codex", ext: "webp" },
  cline: { file: "cline", ext: "webp" },
  opencode: { file: "opencode", ext: "webp" },
  droid: { file: "droid", ext: "webp" },
  hermes: { file: "hermes", ext: "webp" },
  "grok-build": { file: "grok-build", ext: "webp" },
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


export function ToolIcon({
  toolId,
  name,
  color,
  size = 36,
}: {
  toolId?: string;
  name: string;
  color?: string;
  size?: number;
}): ReactNode {
  const [failed, setFailed] = useState(() => (toolId ? failedIcons.has(toolId) : true));
  const asset = toolId ? TOOL_ICONS[toolId] : undefined;
  const letters =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  if (!asset || failed) {
    const bg = color || "var(--accent)";
    return (
      <div
        aria-hidden="true"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: "10px",
          display: "grid",
          placeItems: "center",
          fontSize: `${Math.max(11, Math.floor(size * 0.35))}px`,
          fontWeight: 700,
          color: "white",
          background: bg,
          boxShadow: `0 4px 12px ${bg}33`,
          flexShrink: 0,
        }}
      >
        {letters}
      </div>
    );
  }

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "10px",
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        overflow: "hidden",
        border: "1px solid var(--inner-border)",
      }}
      aria-label={`${name} icon`}
    >
      <img
        src={`${import.meta.env.BASE_URL}providers/${asset.file}.${asset.ext}`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={{ width: "100%", height: "100%", objectFit: "contain", padding: asset.ext === "svg" ? "1px" : "2px" }}
        onError={() => {
          if (toolId) failedIcons.add(toolId);
          setFailed(true);
        }}
      />
    </div>
  );
}
