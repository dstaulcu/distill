import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";
import path from "path";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      browser: "firefox",
    }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@background": path.resolve(__dirname, "src/background"),
      "@content": path.resolve(__dirname, "src/content"),
      "@sidebar": path.resolve(__dirname, "src/sidebar"),
      "@options": path.resolve(__dirname, "src/options"),
    },
  },
  build: {
    target: "firefox109",
    outDir: "dist",
  },
});
