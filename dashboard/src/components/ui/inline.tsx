import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { resolveGap } from "../../lib/spacing";

export interface InlineProps {
  readonly children: ReactNode;
  /** Scale units (`--spacing: 2px`, so `4` is 8px), or a `px` string. */
  readonly gap?: number | string;
  /** Escape hatch for a gap off the 2px step; see `StackProps.gapRaw`. */
  readonly gapRaw?: string;
  readonly align?: CSSProperties["alignItems"];
  readonly justify?: CSSProperties["justifyContent"];
  readonly wrap?: boolean;
  readonly style?: CSSProperties;
  readonly className?: string;
}

const ALIGN: Record<string, string> = {
  center: "items-center",
  start: "items-start",
  end: "items-end",
  "flex-start": "items-start",
  "flex-end": "items-end",
  baseline: "items-baseline",
  stretch: "items-stretch",
};

const JUSTIFY: Record<string, string> = {
  center: "justify-center",
  start: "justify-start",
  end: "justify-end",
  "flex-start": "justify-start",
  "flex-end": "justify-end",
  "space-between": "justify-between",
  "space-around": "justify-around",
  "space-evenly": "justify-evenly",
};

/**
 * The action cluster for a card header.
 *
 * Right alignment comes from `.card-header-action` on the parent
 * (`styles/base.css`), which already sets `margin-left: auto` and
 * `justify-content: flex-end`. This exists so every page names the same
 * primitive for its header actions instead of hand-rolling an `<Inline>`, and
 * so wrapping is consistent: a narrow viewport drops the cluster below the
 * title while keeping it flush right.
 */
export function CardActions({
  children,
  gap = 3,
  gapRaw,
  align = "center",
  justify,
  wrap = true,
  style,
  className = "",
}: InlineProps): ReactNode {
  return (
    <Inline gap={gap} gapRaw={gapRaw} align={align} justify={justify} wrap={wrap} style={style} className={className}>
      {children}
    </Inline>
  );
}

export function Inline({
  children,
  gap = 4,
  gapRaw,
  align = "center",
  justify,
  wrap = false,
  style,
  className = "",
}: InlineProps): ReactNode {
  const gapClass = resolveGap(gap, 4);
  return (
    <div
      className={cn(
        "flex flex-row",
        ALIGN[align ?? ""] ?? "",
        JUSTIFY[justify ?? ""] ?? "",
        wrap && "flex-wrap",
        gapRaw !== undefined ? null : gapClass,
        className,
      )}
      style={gapRaw !== undefined ? { gap: gapRaw, ...style } : style}
    >
      {children}
    </div>
  );
}
