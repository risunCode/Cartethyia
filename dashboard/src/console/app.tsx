import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { Providers, queryClient } from "./providers";
import { router } from "./router";
import { setUnauthorizedHandler } from "../lib/api";
import { ROUTES } from "../routes";

let unauthorizedHandlerConfigured = false;

function configureUnauthorizedHandler(): void {
  if (unauthorizedHandlerConfigured) return;
  unauthorizedHandlerConfigured = true;
  setUnauthorizedHandler(() => {
    queryClient.clear();
    void router.navigate(ROUTES.consoleLogin.replace("/console", ""), { replace: true });
  });
}

export function ConsoleApp(): ReactElement {
  configureUnauthorizedHandler();
  return (
    <StrictMode>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>
  );
}

export function mountConsole(root: HTMLElement): void {
  createRoot(root).render(<ConsoleApp />);
}
