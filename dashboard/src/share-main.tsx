/* @jsxImportSource solid-js */

import { render } from "solid-js/web";

import { SharePage } from "./share-page";
import "./styles/base.css";
import "./styles/share.css";


const root = document.getElementById("root");

if (root === null) {
  throw new Error("Share root element is missing");
}

render(() => <SharePage />, root);
