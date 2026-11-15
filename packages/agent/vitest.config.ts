import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // A test builds the library and the command with esbuild, and starts libsodium's WebAssembly.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
