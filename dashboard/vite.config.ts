/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const dashboardPort = Number(env.CARTETHYIA_DASHBOARD_PORT ?? "5173");
  const daemonPort = env.CARTETHYIA_DAEMON_PORT ?? "12800";
  const daemonTarget = `http://127.0.0.1:${daemonPort}`;

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
        "/console/api": {
          target: daemonTarget,
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/console\/api/, ""),
        },
        "/v2": {
          target: daemonTarget,
          changeOrigin: false,
        },
        "/v1": {
          target: daemonTarget,
          changeOrigin: false,
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
