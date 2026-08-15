/* @jsxImportSource solid-js */

import { ExternalLink, KeyRound } from "lucide-solid";
import { Show } from "solid-js";
import { Button } from "../../components/ui/button";

export interface OAuthFlowCapabilities { readonly browser: boolean; readonly device: boolean; }
interface OAuthConnectActionsProps { readonly flows: OAuthFlowCapabilities; readonly disabled?: boolean; readonly pending?: boolean; readonly onStart: (flow: "browser" | "device") => void; }

/** Explicit OAuth entry points; never hides a supported flow behind a fallback. */
export function OAuthConnectActions(props: OAuthConnectActionsProps) {
  return <Show when={props.flows.browser || props.flows.device}><Show when={props.flows.browser}><Button variant="secondary" className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" disabled={props.disabled || props.pending} onClick={() => props.onStart("browser")} aria-label="Start browser OAuth"><ExternalLink size={12} /> <span class="truncate">{props.pending ? "Starting…" : "Browser OAuth"}</span></Button></Show><Show when={props.flows.device}><Button variant="secondary" className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" disabled={props.disabled || props.pending} onClick={() => props.onStart("device")} aria-label="Start device authorization"><KeyRound size={12} /> <span class="truncate">{props.pending ? "Starting…" : "Device code"}</span></Button></Show></Show>;
}
