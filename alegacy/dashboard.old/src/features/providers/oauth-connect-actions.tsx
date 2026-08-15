import { ExternalLink, KeyRound } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button";

export interface OAuthFlowCapabilities {
  readonly browser: boolean;
  readonly device: boolean;
}

interface OAuthConnectActionsProps {
  readonly flows: OAuthFlowCapabilities;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly onStart: (flow: "browser" | "device") => void;
}

/** Explicit OAuth entry points; never hides a supported flow behind a fallback. */
export function OAuthConnectActions({ flows, disabled = false, pending = false, onStart }: OAuthConnectActionsProps): ReactElement | null {
  if (!flows.browser && !flows.device) return null;
  return (
    <>
      {flows.browser && (
        <Button
          variant="secondary"
          className="h-8 min-w-0 px-2.5 text-[11px]"
          size="sm"
          disabled={disabled || pending}
          onClick={() => onStart("browser")}
          aria-label="Start browser OAuth"
        >
          <ExternalLink size={12} /> <span className="truncate">{pending ? "Starting…" : "Browser OAuth"}</span>
        </Button>
      )}
      {flows.device && (
        <Button
          variant="secondary"
          className="h-8 min-w-0 px-2.5 text-[11px]"
          size="sm"
          disabled={disabled || pending}
          onClick={() => onStart("device")}
          aria-label="Start device authorization"
        >
          <KeyRound size={12} /> <span className="truncate">{pending ? "Starting…" : "Device code"}</span>
        </Button>
      )}
    </>
  );
}
