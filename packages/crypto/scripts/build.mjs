// Builds src/index.ts and everything it needs, libsodium's WebAssembly
// included, into one ES module. Run as `node scripts/build.mjs [outfile]`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// libsodium's WebAssembly glue picks a random number source: the one passed in
// by libsodium-wrappers (globalThis.crypto.getRandomValues), or, if none was
// passed, a `require("crypto")` meant for Node. The wrapper always passes one,
// so that branch never runs; here it is cut out so the output has no Node
// import at all. If a libsodium update changes this text the build stops
// instead of shipping it unseen.
const NODE_RANDOM_FALLBACK = 'require("crypto")';
const NODE_RANDOM_REPLACEMENT = "void 0";

const removeNodeRandomFallback = {
  name: "remove-node-random-fallback",
  setup(buildApi) {
    buildApi.onLoad({ filter: /libsodium-sumo\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const found = source.split(NODE_RANDOM_FALLBACK).length - 1;
      if (found !== 1) {
        throw new Error(
          `expected exactly one ${NODE_RANDOM_FALLBACK} in ${path}, found ${found}; ` +
            "read the new libsodium glue before changing scripts/build.mjs",
        );
      }
      return { contents: source.replace(NODE_RANDOM_FALLBACK, NODE_RANDOM_REPLACEMENT), loader: "js" };
    });
  },
};

export async function buildBundle(outfile) {
  await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    legalComments: "inline",
    plugins: [removeNodeRandomFallback],
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBundle(process.argv[2] ?? fileURLToPath(new URL("../dist/index.js", import.meta.url)));
}
