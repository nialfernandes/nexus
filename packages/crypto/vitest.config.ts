import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Argon2id at 64 MiB takes a few seconds under WebAssembly.
    testTimeout: 60_000,
  },
});
