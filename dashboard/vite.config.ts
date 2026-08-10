/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/console/",
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
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts")) return "vendor-charts";
          if (id.includes("react-markdown") || id.includes("remark-gfm") || id.includes("remark-parse")) return "vendor-markdown";
          return undefined;
        },
      },
    },
  },
});
