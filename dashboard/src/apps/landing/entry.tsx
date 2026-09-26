import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingPage } from "./page";
import "../../styles/base.css";
import "../../styles/landing.css";

/** Mounts the public landing story into the shared dashboard document. */
export function mountLanding(root: HTMLElement): void {
  document.title = "Cartethyia — The One-Stop AI Proxy Router";
  createRoot(root).render(
    <StrictMode>
      <LandingPage />
    </StrictMode>,
  );
}
