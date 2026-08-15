/* @jsxImportSource solid-js */

/**
 * Route error boundary — replaces the router's development fallback with an
 * in-app screen. A stale-chunk navigation already self-heals via a one-time
 * reload in the router, so anything reaching here is a real failure worth
 * showing plainly.
 */

import { useNavigate } from "@solidjs/router";
import { RotateCw, TriangleAlert } from "lucide-solid";
import type { JSX } from "solid-js";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { IconBadge } from "../components/ui/icon";

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    const statusText = "statusText" in error && typeof error.statusText === "string" ? error.statusText : "";
    return `${error.status} ${statusText}`.trim();
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export interface RouteErrorProps {
  error?: unknown;
}

export function RouteError(props: RouteErrorProps = {}): JSX.Element {
  const navigate = useNavigate();

  return (
    <div class="grid min-h-screen place-items-center p-4">
      <Card density="comfortable" className="max-w-md text-center">
        <IconBadge icon={TriangleAlert} tone="danger" size="lg" className="mx-auto" />
        <h1 class="mt-3.5 text-base font-bold">This page failed to load</h1>
        <p class="mt-1.5 text-[12.5px] text-[var(--text-2)]">
          Reloading usually fixes it — the console may have been updated while this tab was open.
        </p>
        <code class="mt-3 block break-words rounded-lg bg-[var(--kbd-bg)] px-3 py-2 text-left font-mono text-[11px] text-[var(--text-3)]">
          {describe(props.error)}
        </code>
        <div class="mt-4 flex justify-center gap-2">
          <Button type="button" size="sm" onClick={() => window.location.assign(`${window.location.pathname}?_bust=${Date.now()}`)}>
            <RotateCw size={13} /> Reload
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/overview")}>
            Back to Overview
          </Button>
        </div>
      </Card>
    </div>
  );
}
