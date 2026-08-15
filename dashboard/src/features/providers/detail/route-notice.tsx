/* @jsxImportSource solid-js */

import { cn } from "../../../lib/cn";
import { formatHealthAccessibleStatus, formatRouteHealthStatus } from "../../../lib/account-health";
import type { RouteState } from "./types";

export function RouteNotice(props: { title: string; route: RouteState; tone: "failed" | "replacement" }) {
  const health = props.route.health ?? (props.route.status
    ? {
        status: props.route.status,
        failureKind: props.route.failureKind ?? null,
        statusCode: props.route.statusCode ?? null,
        sanitizedMessage: props.route.sanitizedMessage ?? null,
        retryAt: props.route.retryAt ?? null,
      }
    : null);
  const label = props.route.label ?? props.route.name ?? props.route.routeId ?? props.route.id ?? "unknown route";

  return (
    <div class={cn(
      "rounded-xl border px-3 py-2.5",
      props.tone === "failed" ? "border-[var(--red)]/35 bg-[var(--red)]/5" : "border-[var(--green)]/35 bg-[var(--green)]/5",
    )}>
      <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{props.title}</div>
      <div class="mt-1 truncate text-xs font-semibold">{label}</div>
      <div
        class={cn("mt-0.5 truncate text-[10px]", props.tone === "failed" ? "text-[var(--red)]" : "text-[var(--green)]")}
        aria-label={`${props.title} health: ${formatHealthAccessibleStatus(health) ?? "No health details"}`}
      >
        {formatRouteHealthStatus({ health }) ?? "No health details"}
      </div>
    </div>
  );
}
