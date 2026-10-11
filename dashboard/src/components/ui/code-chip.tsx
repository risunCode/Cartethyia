import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type CodeChipTone = "plain" | "muted" | "accent";

export interface CodeChipProps extends HTMLAttributes<HTMLElement> {
  /** Monospaced value to render. Rendered as-is; no truncation is applied —
   *  pass a `title` and constrain the container when a value can be long. */
  readonly value: string;
  /** `plain` is bare mono text; `muted` sits on a soft chip; `accent` tints
   *  it with the accent color (e.g. an alias name). */
  readonly tone?: CodeChipTone;
  /** Optional trailing action, e.g. a remove button in an editable list. */
  readonly action?: ReactNode;
}

const toneClass: Record<CodeChipTone, string> = {
  plain: "code-chip-plain",
  // `--surface-3` is not a defined token — only share.css referenced it, and
  // nothing defined it — so the soft chip uses the real `surface-muted` token.
  muted:
    "code-chip-muted text-text-secondary bg-surface-muted border border-inner-border px-4 py-1 rounded-chip",
  accent: "code-chip-accent text-accent bg-accent-soft px-4 py-1.5 rounded-chip font-bold",
};

/**
 * A monospaced value chip — model ids, aliases, combo members, header pairs.
 *
 * Replaces the `fontFamily: "var(--font-mono)"` inline idiom that pages had
 * been re-declaring by hand; one class owns the font, size, and tone so the
 * chips cannot drift apart across routes.
 */
export function CodeChip({
  value,
  tone = "muted",
  action,
  className = "",
  children,
  ...props
}: CodeChipProps): ReactNode {
  return (
    <span
      className={cn(
        "code-chip inline-flex items-center gap-3 min-w-0 max-w-full font-mono text-sm tabular-nums",
        toneClass[tone],
        className,
      )}
      {...props}
    >
      <code
        className="code-chip-value min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={props.title ?? value}
      >
        {value}
      </code>
      {action ? <span className="code-chip-action inline-flex shrink-0">{action}</span> : null}
      {children}
    </span>
  );
}
