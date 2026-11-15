// Vitest configuration for the Nexus server.
//
// The tests run in plain Node. The logic never touches a host (it talks only to the ports in src/ports.ts), and the
// Cloudflare plug is tested against a stand-in for D1 made from node:sqlite (`memoryD1` in packages/test-sqlite), so no
// Cloudflare runtime is needed to run them.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // A test here is a few database round trips, not a benchmark. On a machine that other jobs are sharing it can run
    // many times slower than alone, and 30 seconds still stops a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
