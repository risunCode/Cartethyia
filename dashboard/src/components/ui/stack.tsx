import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";

type StackDirection = "row" | "column";

export interface StackProps {
  readonly children: ReactNode;
  readonly direction?: StackDirection;
  readonly gap?: number | string;
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
  gap = "12px",
  align,
  justify,
  wrap = false,
  style,
  className = "",
}: StackProps): ReactNode {
  return (
    <div
      className={cn(
        "flex",
        direction === "row" ? "flex-row" : "flex-col",
        ALIGN[align ?? ""] ?? "",
        JUSTIFY[justify ?? ""] ?? "",
        wrap && "flex-wrap",
        className,
      )}
      style={{ gap, ...style }}
    >
      {children}
    </div>
  );
}
