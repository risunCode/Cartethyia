import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import { LandingPage } from "./landing/page";
import { ConsoleApp } from "./console/app";
import { isConsolePath } from "./routes";
import "./index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element is missing");
}

const App = isConsolePath(window.location.pathname) ? ConsoleApp : LandingPage;

createRoot(root).render(
  <StrictMode>
    {createElement(App)}
  </StrictMode>,
);
