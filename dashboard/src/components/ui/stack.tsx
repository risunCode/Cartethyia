import type { CSSProperties, ReactNode } from "react";

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
      className={className}
      style={{
        display: "flex",
        flexDirection: direction,
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
