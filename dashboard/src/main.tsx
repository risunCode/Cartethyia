/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { isConsolePath } from "./routes";
import "./styles/base.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element is missing");
}

const mountRoot = root;

if (window.location.pathname === "/") {
  window.history.replaceState(null, "", "/home");
}

const path = window.location.pathname;

/* Route-level code splitting keeps landing, console, and share CSS out of unrelated entry chunks. */
async function mountRoute(): Promise<void> {
  if (path === "/share-preview") {
    const [{ SharePage }] = await Promise.all([
      import("./share-page"),
      import("./styles/share.css"),
    ]);
    render(() => <SharePage preview />, mountRoot);
    return;
  }

  if (isConsolePath(path)) {
    const [{ ConsoleApp }] = await Promise.all([
      import("./console/app"),
      import("./styles/console.css"),
    ]);
    render(() => <ConsoleApp />, mountRoot);
    return;
  }

  const [{ LandingPage }] = await Promise.all([
    import("./landing/page"),
    import("./styles/landing.css"),
  ]);
  render(() => <LandingPage />, mountRoot);
}

void mountRoute();

