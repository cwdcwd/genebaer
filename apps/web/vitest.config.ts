import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * No @vitejs/plugin-react here on purpose: its Vite-internal imports do not
 * line up with the Vite that vitest resolves, and the only thing these tests
 * need from it is the JSX transform — which esbuild does natively below.
 * Fast Refresh is a dev-server concern and irrelevant in a test run.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // next build owns .next/; keep vitest away from it.
    exclude: ["node_modules/**", ".next/**"],
  },
});
