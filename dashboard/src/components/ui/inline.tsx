import type { CSSProperties, ReactNode } from "react";

export interface InlineProps {
  readonly children: ReactNode;
  readonly gap?: number | string;
  readonly align?: CSSProperties["alignItems"];
  readonly justify?: CSSProperties["justifyContent"];
  readonly wrap?: boolean;
  readonly style?: CSSProperties;
  readonly className?: string;
}

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
      className={className}
      style={{
        display: "flex",
        flexDirection: "row",
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
