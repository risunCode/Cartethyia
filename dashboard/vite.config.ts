import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendTarget = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:12800";

/**
 * Dev-server routing for the shared index document: `/` serves the landing app,
 * `/console/*` the admin console, and `/share/*` the public share app. The
 * production server implements the same mapping in
 * `src/console/dashboard-assets.ts`.
 */
function multiPageRouting(): Plugin {
  return {
    name: "cartethyia-multi-page-routing",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname === "/console" || pathname.startsWith("/console/")) {
          // The console API namespace is proxied to the gateway, not the SPA.
          if (!pathname.startsWith("/console/api")) req.url = "/index.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: "/",
  appType: "spa",
  plugins: [multiPageRouting(), react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/console/api": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/v1": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/health": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/metrics": {
        target: backendTarget,
        changeOrigin: false,
      },
      // Share API routes are proxied; public page deep links use index.html.
      "/share": {
        target: backendTarget,
        changeOrigin: false,
        bypass: (req) => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          if (path.endsWith("/data") || path.endsWith("/issue")) return undefined;
          return "/index.html";
        },
      },
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: "index.html",
      },
    },
  },
});
