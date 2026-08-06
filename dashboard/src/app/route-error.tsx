/**
 * Route error boundary — replaces React Router's development fallback with an
 * in-app screen. A stale-chunk navigation already self-heals via a one-time
 * reload in the router, so anything reaching here is a real failure worth
 * showing plainly.
 */

import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { IconBadge } from "../components/ui/icon";

function describe(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card density="comfortable" className="max-w-md text-center">
        <IconBadge icon={TriangleAlert} tone="danger" size="lg" className="mx-auto" />
        <h1 className="mt-3.5 text-base font-bold">This page failed to load</h1>
        <p className="mt-1.5 text-[12.5px] text-[var(--text-2)]">
          Reloading usually fixes it — the console may have been updated while this tab was open.
        </p>
        <code className="mt-3 block break-words rounded-lg bg-[var(--kbd-bg)] px-3 py-2 text-left font-mono text-[11px] text-[var(--text-3)]">
          {describe(error)}
        </code>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" size="sm" onClick={() => window.location.assign(`${location.pathname}?_bust=${Date.now()}`)}>
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
