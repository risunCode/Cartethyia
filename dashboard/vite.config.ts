/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const dashboardPort = Number(env.CARTETHYIA_DASHBOARD_PORT ?? "5173");
  const daemonPort = env.CARTETHYIA_DAEMON_PORT ?? "12800";

  return {
  base: "/",
  plugins: [
    solid({ hot: false }),
    tailwindcss(),
  ],
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
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/console\/api/, ""),
      },
      "/v1": {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        dashboard: "index.html",
        share: "share.html",
      },
    },
  },
  };
});
