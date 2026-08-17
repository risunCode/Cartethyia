import { Toaster } from "solid-sonner";
import { Show, type JSX } from "solid-js";
import { mobileNavOpen } from "@lib/store";

/** Official Sonner viewport, hidden while the mobile navigation drawer is open. */
export function ToastViewport(): JSX.Element {
  return (
    <Show when={!mobileNavOpen()}>
      <Toaster />
    </Show>
  );
}
