import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Providers, queryClient } from "./app/providers";
import { router } from "./app/router";
import { setUnauthorizedHandler } from "./lib/api";
import "./index.css";

// Both the router and the handler slot are module singletons, so this needs no
// React context — which is what made the previous in-tree bridge crash.
setUnauthorizedHandler(() => {
  queryClient.clear();
  void router.navigate("/login", { replace: true });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>
);
