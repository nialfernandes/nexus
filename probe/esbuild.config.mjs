// Builds src/main.ts into dist/main.js and copies manifest.json beside it.
// Run with: node esbuild.config.mjs
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "dist");

// Modules this bundle may leave as a runtime require(). Obsidian supplies
// "obsidian" itself; nothing else may remain, and the check below enforces it.
export const ALLOWED_EXTERNAL_REQUIRES = ["obsidian"];

// Text that would mean a Node or Electron import reached the bundle.
export const FORBIDDEN_IN_BUNDLE = [
  /require\(\s*["'](?:node:)?(?:fs|path|os|crypto|child_process|http|https|net|tls|zlib|stream|buffer|util|url|worker_threads|module|vm)["']\s*\)/,
  /require\(\s*["']node:/,
  /require\(\s*["']electron["']\s*\)/,
  /from\s*["']node:/,
  /from\s*["']electron["']/,
  /\bimport\(\s*["']node:/,
];

/** Builds into outDir (dist/ unless a caller, such as a test, asks for another). */
export async function buildProbe(outDir = distDir) {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(here, "src/main.ts")],
    outfile: join(outDir, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    // The ES module build of libsodium reads import.meta.url inside a try block;
    // there is no module URL in a plugin file, so give it an empty one.
    define: { "import.meta.url": '""' },
    alias: { crypto: join(here, "src/shims/no-node-crypto.ts") },
    external: ALLOWED_EXTERNAL_REQUIRES,
    minify: false,
    legalComments: "inline",
    logLevel: "info",
  });
  copyFileSync(join(here, "manifest.json"), join(outDir, "manifest.json"));
  const bundle = readFileSync(join(outDir, "main.js"), "utf8");
  for (const pattern of FORBIDDEN_IN_BUNDLE) {
    const hit = bundle.match(pattern);
    if (hit) throw new Error(`dist/main.js has a Node or Electron import: ${hit[0]}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildProbe();
}
