// Builds the command to dist/cli.js, and the Worker to dist/worker.js with libsodium's WebAssembly as a file beside it,
// dist/nexus-agent.wasm. Run as `node scripts/build.mjs [outdir]`.
//
// Both take the agent's built library (packages/agent/dist/nexus-agent.js) as it is and put it inside: the command is a Node program, and
// the Worker is one ES module that imports only the WebAssembly file beside it, which a Worker takes as a compiled module. A deploy
// with `wrangler` bundles src/worker.ts itself (wrangler.example.toml); this build is what the tests run in a Worker runtime.
//
// @nexus/agent is taken as it is built, so build it first (the repository's `npm run build` does).

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const COMMON = {
  // The notes esbuild writes above each file in the bundle name the file from here, so the same sources make the same bytes wherever the build is run from.
  absWorkingDir: here("../"),
  bundle: true,
  format: "esm",
  target: "es2022",
  mainFields: ["module", "main"],
  legalComments: "inline",
  logLevel: "warning",
};

/** The WebAssembly the agent's library needs, beside the Worker. */
const AGENT_WASM = "../../agent/dist/nexus-agent.wasm";

/** A Worker imports `@nexus/agent/nexus-agent.wasm` as a compiled module: in the built file it is the file beside it. */
const wasmBesideTheWorker = {
  name: "wasm-beside-the-worker",
  setup(buildApi) {
    buildApi.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./nexus-agent.wasm", external: true }));
  },
};

async function requireAgent() {
  try {
    await stat(here("../../agent/dist/nexus-agent.js"));
    await stat(here(AGENT_WASM));
  } catch {
    throw new Error("packages/agent/dist is missing: build @nexus/agent first (npm run build --workspace @nexus/agent).");
  }
}

/** Builds the command, a Node program, at `outfile`. Its first line, the `#!` line, is the entry file's own, which esbuild keeps. */
export async function buildCommand(outfile) {
  await requireAgent();
  await build({ ...COMMON, entryPoints: [here("../src/bin.ts")], outfile, platform: "node" });
  await chmod(outfile, 0o755);
}

/** Builds the Worker at `outfile` and copies the WebAssembly it imports beside it. */
export async function buildWorker(outfile) {
  await requireAgent();
  await build({ ...COMMON, entryPoints: [here("../src/worker.ts")], outfile, platform: "neutral", plugins: [wasmBesideTheWorker] });
  await copyFile(here(AGENT_WASM), join(outfile, "..", "nexus-agent.wasm"));
}

/** SHA-256 of a file, as 64 lower case hex characters. */
export async function sha256Of(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outdir = process.argv[2] ?? here("../dist");
  await mkdir(outdir, { recursive: true });
  const command = join(outdir, "cli.js");
  const worker = join(outdir, "worker.js");
  await buildCommand(command);
  await buildWorker(worker);
  for (const file of [command, worker, join(outdir, "nexus-agent.wasm")]) console.log(`${await sha256Of(file)}  ${basename(file)}`);
}
