/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const dashboardPort = Number(env.CARTETHYIA_DASHBOARD_PORT ?? "5173");
  const daemonPort = env.CARTETHYIA_DAEMON_PORT ?? "12800";
  const daemonTarget = `http://127.0.0.1:${daemonPort}`;
  const auditTarget = `http://127.0.0.1:${env.CARTETHYIA_DASHBOARD_SERVER_PORT ?? "8787"}`;

  return {
    base: "/",
    plugins: [solid({ hot: false }), tailwindcss()],
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
      globals: false,
      css: false,
    },
    server: {
      port: dashboardPort,
      proxy: {
        "/console": {
          target: daemonTarget,
          changeOrigin: false,
        },
        "/v1": {
          target: daemonTarget,
          changeOrigin: false,
        },
        "/internal": {
          target: auditTarget,
          changeOrigin: false,
        },
        // Only the daemon's public share API subpaths (monitor data, monitor
        // stream, and the one-shot setup flow) are proxied; every other
        // /share/* path is the SPA's share page and must stay local.
        "/share": {
          target: daemonTarget,
          changeOrigin: false,
          bypass: (req) => {
            const path = (req.url ?? "").split("?")[0].replace(/^\/share\/?/, "");
            if (path.endsWith("/data") || path.endsWith("/stream") || path.startsWith("setup/")) {
              return undefined;
            }
            return "/index.html";
          },
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "solid-vendor": ["solid-js", "@solidjs/router"],
            "tanstack-vendor": ["@tanstack/solid-virtual"],
          },
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      alias: {
        "@": "/src",
        "@components": "/src/components",
        "@lib": "/src/lib",
        "@pages": "/src/pages",
        "@styles": "/src/styles",
      },
    },
  };
});
