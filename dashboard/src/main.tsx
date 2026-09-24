
import { resolveDashboardApp } from "./lib/app-entry";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Dashboard root element is missing");
}

const app = resolveDashboardApp(window.location.pathname);

if (app === "console") {
  void import("./apps/console/entry").then(({ mountConsole }) => mountConsole(rootElement));
} else {
  void import("./apps/landing/entry").then(({ mountLanding }) => mountLanding(rootElement));
}
