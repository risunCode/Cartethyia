/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: false,
    css: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/console/api": {
        target: "http://127.0.0.1:12800",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/console\/api/, ""),
      },
      "/v1": {
        target: "http://127.0.0.1:12800",
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
});
