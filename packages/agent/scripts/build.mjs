// Builds the library to ONE file, dist/nexus-agent.js, and the command to dist/cli.js. Run as `node scripts/build.mjs [outdir]`.
//
// dist/nexus-agent.js is an ES module that imports nothing: @nexus/crypto, libsodium's WebAssembly and the merge are inside it, so
// another repository can copy it, pin it, and check it by its checksum. It runs in Node and in a Cloudflare Worker. The build prints
// the file's SHA-256 in the form `sha256sum -c` reads. The same sources always make the same file, so a checksum taken from one
// build is the checksum of every other.
//
// @nexus/crypto is taken as it is built (packages/crypto/dist/index.js), so build it first (the repository's `npm run build` does).

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const COMMON = {
  bundle: true,
  format: "esm",
  target: "es2022",
  mainFields: ["module", "main"],
  legalComments: "inline",
  logLevel: "warning",
  // libsodium's glue reads `import.meta.url` inside a try block. The built file has no module address to read in every place it runs,
  // so it is given an empty one, and the file holds no `import.meta` at all.
  define: { "import.meta.url": '""' },
};

/** Builds the library file at `outfile`. */
export async function buildLibrary(outfile) {
  await requireCrypto();
  await build({ ...COMMON, entryPoints: [here("../src/index.ts")], outfile, platform: "neutral" });
}

/** Builds the command at `outfile`, a Node program with its own copy of the library inside. Its first line, the `#!` line, is the entry file's own, which esbuild keeps. */
export async function buildCommand(outfile) {
  await requireCrypto();
  await build({ ...COMMON, entryPoints: [here("../src/cli/bin.ts")], outfile, platform: "node" });
  await chmod(outfile, 0o755);
}

/** SHA-256 of a file, as 64 lower case hex characters. */
export async function sha256Of(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function requireCrypto() {
  try {
    await stat(here("../../crypto/dist/index.js"));
  } catch {
    throw new Error("packages/crypto/dist/index.js is missing: build @nexus/crypto first (npm run build --workspace @nexus/crypto).");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outdir = process.argv[2] ?? here("../dist");
  await mkdir(outdir, { recursive: true });
  const library = join(outdir, "nexus-agent.js");
  await buildLibrary(library);
  await buildCommand(join(outdir, "cli.js"));
  console.log(`${await sha256Of(library)}  nexus-agent.js`);
}
