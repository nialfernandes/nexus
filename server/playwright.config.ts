// Playwright's configuration for the browser spec of the device approval page (e2e/approve.spec.ts). It is run on its own, with
// `npm run test:browser --workspace nexus-server`: it needs a browser that `npm ci` does not download (server/README.md, "The browser spec"),
// so it is not part of `npm run check`. The spec serves the page's real files from public/nexus
// and answers the page's calls with the shapes in src/__fixtures__/approve-answers.ts, so it needs no server of its own.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["line"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
