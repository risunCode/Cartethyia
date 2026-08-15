/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { Providers, queryClient } from "./providers";
import { ConsoleRouter } from "./router";
import { setUnauthorizedHandler } from "../lib/api";

let unauthorizedHandlerConfigured = false;

function configureUnauthorizedHandler(): void {
  if (unauthorizedHandlerConfigured) return;
  unauthorizedHandlerConfigured = true;
  setUnauthorizedHandler(() => {
    queryClient.clear();
    window.location.replace("/console/login");
  });
}

export function ConsoleApp() {
  configureUnauthorizedHandler();
  return (
    <Providers>
      <ConsoleRouter />
    </Providers>
  );
}

export function mountConsole(root: HTMLElement): void {
  render(() => <ConsoleApp />, root);
}
