import { useState } from "react";
import type { ReactNode } from "react";
import { Bot, Brain, Check, ChevronDown, Copy, User, Wrench } from "lucide-react";
import type { StudioMessage } from "../../lib/contracts";
import { formatStudioMs } from "../../lib/studio-stream";
import { formatTokens as formatTokenCount } from "../../lib/format";
import { toast } from "../../lib/toast";
import { useClipboard } from "../../lib/use-clipboard";

function formatTokens(usage: StudioMessage["usage"]): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`in ${formatTokenCount(usage.input)}`);
  if (usage.output !== undefined) parts.push(`out ${formatTokenCount(usage.output)}`);
  if (usage.reasoning !== undefined) parts.push(`think ${formatTokenCount(usage.reasoning)}`);
  if (usage.cached !== undefined) parts.push(`cached ${formatTokenCount(usage.cached)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function Thinking({ reasoning, streaming }: { reasoning: string; streaming: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  if (streaming) {
    if (!reasoning) return null;
    return (
      <div style={{ marginBottom: "8px", marginTop: "4px" }} aria-live="polite">
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            background: "var(--surface-muted)",
            padding: "8px 12px",
            borderRadius: "12px",
          }}
        >
          {reasoning}
        </div>
      </div>
    );
  }
  if (!reasoning) return null;
  return (
    <div style={{ marginBottom: "8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          border: "none",
          borderRadius: "9999px",
          background: "var(--surface-muted)",
          color: "var(--text-secondary)",
          fontSize: "10.5px",
          fontWeight: 600,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        <Brain size={12} /> {open ? "Hide thinking" : "Show thinking"}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <div
          style={{
            marginTop: "6px",
            padding: "8px 12px",
            background: "var(--surface-muted)",
            borderRadius: "12px",
            color: "var(--text-secondary)",
            fontSize: "12px",
            fontStyle: "italic",
            whiteSpace: "pre-wrap",
          }}
        >
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}

export function ToolChips({ message }: { message: StudioMessage }): ReactNode {
  const [open, setOpen] = useState(false);
  const calls = message.toolRounds?.flatMap((round) => round.toolCalls) ?? [];
  if (calls.length === 0) return null;
  return (
    <div style={{ marginBottom: "8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          border: "1px solid var(--inner-border)",
          borderRadius: "9999px",
          background: "var(--surface-muted)",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 600,
          padding: "3px 10px",
          cursor: "pointer",
        }}
      >
        <Wrench size={11} /> {calls.length} tool call{calls.length === 1 ? "" : "s"}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {calls.map((call, index) => (
            <div
              key={`${call.name}-${index}`}
              style={{
                border: "1px solid var(--inner-border)",
                borderRadius: "8px",
                background: "var(--code-surface)",
                padding: "8px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
              }}
            >
              <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{call.name}</div>
              <div style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>
                → {call.args}
              </div>
              <div style={{ color: "var(--status-success)", wordBreak: "break-all" }}>
                ← {call.result}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MessageMeta({ message }: { message: StudioMessage }): ReactNode {
  const tokens = formatTokens(message.usage);
  if (!tokens && message.ttfbMs === undefined && message.completionMs === undefined) return null;
  const times = [
    message.ttfbMs === undefined ? null : `ttfb ${formatStudioMs(message.ttfbMs)}`,
    message.completionMs === undefined ? null : `total ${formatStudioMs(message.completionMs)}`,
  ].filter((part): part is string => part !== null);
  const detail = [...(tokens ? [tokens] : []), ...times].join(" · ");
  return (
    <div
      title={detail}
      style={{
        marginTop: "6px",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        color: "var(--text-tertiary)",
      }}
    >
      {detail}
    </div>
  );
}

export function Avatar({ kind }: { kind: "user" | "assistant" }): ReactNode {
  const Icon = kind === "user" ? User : Bot;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: "26px",
        height: "26px",
        borderRadius: "9999px",
        flexShrink: 0,
        background: kind === "user" ? "var(--accent-soft)" : "var(--surface-muted)",
        color: kind === "user" ? "var(--accent)" : "var(--text-secondary)",
        border: "1px solid var(--inner-border)",
      }}
    >
      <Icon size={13} />
    </span>
  );
}

export function CopyButton({ text }: { text: string }): ReactNode {
  const { copied, copy } = useClipboard();
  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={() => {
        void copy(text).then((ok) => {
          if (!ok) toast.error("Copy failed");
        });
      }}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: copied ? "var(--status-success)" : "var(--text-tertiary)",
        padding: "2px",
        display: "inline-flex",
        opacity: copied ? 1 : 0.55,
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
