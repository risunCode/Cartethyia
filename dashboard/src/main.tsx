/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { LandingPage } from "./landing/page";
import { ConsoleApp } from "./console/app";
import { isConsolePath } from "./routes";
import "./index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element is missing");
}

if (window.location.pathname === "/") {
  window.history.replaceState(null, "", "/home");
}

const App = isConsolePath(window.location.pathname) ? ConsoleApp : LandingPage;

render(() => <App />, root);
