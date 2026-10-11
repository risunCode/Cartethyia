import type { ReactNode } from "react";

/**
 * Keeps every provider catalog section on the same responsive grid contract.
 * Cards remain responsible for their own content and interactions.
 */
export function ProviderCardGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className="provider-grid grid gap-6 w-full min-w-0">{children}</div>;
}
