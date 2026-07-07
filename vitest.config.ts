import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
  },
  resolve: {
    alias: {
      "@shared": new URL("./src/shared", import.meta.url).pathname,
      "@background": new URL("./src/background", import.meta.url).pathname,
      "@content": new URL("./src/content", import.meta.url).pathname,
      "@sidebar": new URL("./src/sidebar", import.meta.url).pathname,
      "@options": new URL("./src/options", import.meta.url).pathname,
    },
  },
});
