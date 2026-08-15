/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { LandingPage } from "./page";
import "../styles/base.css";
import "../styles/landing.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Landing root element is missing");
}

render(() => <LandingPage />, root);
