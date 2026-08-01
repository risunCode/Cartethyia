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

// Warm route chunks after the first paint so sidebar navigation does not leave
// the previous page visible while a rarely visited lazy route downloads.
window.setTimeout(() => {
  void Promise.allSettled([
    import("./features/overview/page"),
    import("./features/usage/page"),
    import("./features/providers/page"),
    import("./features/providers/custom-detail"),
    import("./features/providers/detail"),
    import("./features/combos/page"),
    import("./features/console-log/page"),
    import("./features/settings/page"),
  ]);
}, 1200);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>
);
