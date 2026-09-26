import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SharePage } from "./page";
import "../../styles/base.css";
import "../../styles/share.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Share root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <SharePage />
  </StrictMode>,
);
