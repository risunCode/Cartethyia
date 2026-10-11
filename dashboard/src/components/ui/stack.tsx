import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { resolveGap } from "../../lib/spacing";

type StackDirection = "row" | "column";

export interface StackProps {
  readonly children: ReactNode;
  readonly direction?: StackDirection;
  /** Scale units (`--spacing: 2px`, so `4` is 8px), or a `px` string. */
  readonly gap?: number | string;
  /**
   * Escape hatch for a gap that is genuinely off the 2px step (a `calc()`, a
   * percentage). Reaches the DOM as an inline style, so it is exempt from the
   * style guard by being named — unlike an off-scale value dropped into `gap`,
   * which would silently become an arbitrary utility.
   */
  readonly gapRaw?: string;
  readonly align?: CSSProperties["alignItems"];
  readonly justify?: CSSProperties["justifyContent"];
  readonly wrap?: boolean;
  readonly style?: CSSProperties;
  readonly className?: string;
}

/** Maps an alignment value onto its Tailwind utility. */
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

export function Stack({
  children,
  direction = "column",
  gap = 6,
  gapRaw,
  align,
  justify,
  wrap = false,
  style,
  className = "",
}: StackProps): ReactNode {
  const gapClass = resolveGap(gap, 6);
  return (
    <div
      className={cn(
        "flex",
        direction === "row" ? "flex-row" : "flex-col",
        ALIGN[align ?? ""] ?? "",
        JUSTIFY[justify ?? ""] ?? "",
        wrap && "flex-wrap",
        // An off-scale gap has no utility; the escape hatch carries it instead.
        gapRaw !== undefined ? null : gapClass,
        className,
      )}
      style={gapRaw !== undefined ? { gap: gapRaw, ...style } : style}
    >
      {children}
    </div>
  );
}
