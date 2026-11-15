import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // A test starts the real server code and libsodium's WebAssembly, and one builds the Worker.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
