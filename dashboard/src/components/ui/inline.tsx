import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface InlineProps {
  readonly children: ReactNode;
  readonly gap?: number | string;
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

export function Inline({
  children,
  gap = "8px",
  align = "center",
  justify,
  wrap = false,
  style,
  className = "",
}: InlineProps): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-row",
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
