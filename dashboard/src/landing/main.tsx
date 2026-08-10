import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingPage } from "./page";
import { initializeMotionProfile } from "../lib/motion";
import "../index.css";

initializeMotionProfile();

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Landing root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
