import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `globals: false` in vite.config.ts means Testing Library's own auto-cleanup
// (which hooks the global `afterEach`) never registers - without this, every
// test's rendered tree stays mounted into the next test's DOM.
afterEach(() => {
  cleanup();
});
