/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { LandingPage } from "./page";
import "../index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Landing root element is missing");
}

render(() => <LandingPage />, root);
