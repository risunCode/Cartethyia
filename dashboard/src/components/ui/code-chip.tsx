import type { HTMLAttributes, ReactNode } from "react";

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
  muted: "code-chip-muted",
  accent: "code-chip-accent",
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
    <span className={`code-chip ${toneClass[tone]} ${className}`.trim()} {...props}>
      <code className="code-chip-value" title={props.title ?? value}>
        {value}
      </code>
      {action ? <span className="code-chip-action">{action}</span> : null}
      {children}
    </span>
  );
}
