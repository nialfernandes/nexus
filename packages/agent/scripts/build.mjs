// Builds the library to ONE file, dist/nexus-agent.js, with libsodium's WebAssembly as a file beside it, dist/nexus-agent.wasm, and the
// command to dist/cli.js. Run as `node scripts/build.mjs [outdir]`.
//
// dist/nexus-agent.js is an ES module that imports nothing: @nexus/crypto, libsodium's WebAssembly and the merge are inside it, so
// another repository can copy it, pin it, and check it by its checksum. It runs in Node and in a Cloudflare Worker. A Worker will not
// make code from bytes, so the WebAssembly is also written out as dist/nexus-agent.wasm, the very bytes that are inside the file: a Worker
// imports that file as a module and gives it to the library (`AgentOptions.wasm`), and src/wasm-gate.ts is how libsodium takes it.
// Without a module the library starts libsodium from the bytes inside the file, as it always did. The build prints the SHA-256 of each
// file it made, in the form `sha256sum -c` reads. The same sources always make the same files, so a checksum taken from one build is the
// checksum of every other.
//
// @nexus/crypto is taken as it is built (packages/crypto/dist/index.js), so build it first (the repository's `npm run build` does).

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  // libsodium's glue reads `import.meta.url` inside a try block. The built file has no module address to read in every place it runs,
  // so it is given an empty one, and the file holds no `import.meta` at all.
  define: { "import.meta.url": '""' },
};

// libsodium's glue ends its start-up with `var imports = { a: ... }; return options.instantiateWasm ? ... : <make it from the bytes inside>`.
// The names are esbuild's, so only the shape is matched: the call that is put between the two waits for the vault (src/wasm-gate.ts) and
// may put a module of its own in `instantiateWasm`. If a libsodium update changes this text the build stops instead of shipping it unseen.
const WASM_CHOICE = /(var (\w+) = \{ a: \w+ \};)(\s*)(return (\w+)\.instantiateWasm \?)/g;
// The WebAssembly inside the glue is one long string of base64 that begins with the module's magic number (\0asm).
const WASM_TEXT = /\("(AGFzbQ[A-Za-z0-9+/]+={0,2})"\)/g;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/**
 * Takes @nexus/crypto's libsodium glue and puts a wait for the vault in its start-up (see WASM_CHOICE). Fills `found.wasm` with the
 * WebAssembly bytes that are inside the glue, so they can be written out beside the library.
 */
function wasmGate(found) {
  return {
    name: "wasm-gate",
    setup(buildApi) {
      buildApi.onLoad({ filter: /packages[\\/]crypto[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const choices = [...source.matchAll(WASM_CHOICE)];
        const texts = [...source.matchAll(WASM_TEXT)];
        if (choices.length !== 1 || texts.length !== 1) {
          throw new Error(
            `expected exactly one place where libsodium picks how to make its WebAssembly and one text of it in ${path}, found ${choices.length} and ${texts.length}; ` +
              "read the new libsodium glue before changing scripts/build.mjs",
          );
        }
        const bytes = Buffer.from(texts[0][1], "base64");
        if (!WASM_MAGIC.every((byte, at) => bytes[at] === byte)) throw new Error(`the text found in ${path} is not a WebAssembly module`);
        found.wasm = bytes;
        const gate = here("../src/wasm-gate.ts");
        const patched = source.replace(WASM_CHOICE, "$1$3await __nexusChooseWasm($5, $2);$3$4");
        return { contents: `import { chooseWasm as __nexusChooseWasm } from ${JSON.stringify(gate)};\n${patched}`, loader: "js", resolveDir: here("../../crypto/dist/") };
      });
    },
  };
}

/** Where the WebAssembly goes for a library written to `outfile`: the same name, beside it. */
export const wasmFileFor = (outfile) => outfile.replace(/\.js$/, ".wasm");

/** Builds the library file at `outfile`, and the WebAssembly it holds beside it (`wasmFileFor`). */
export async function buildLibrary(outfile) {
  await requireCrypto();
  const found = {};
  await build({ ...COMMON, entryPoints: [here("../src/index.ts")], outfile, platform: "neutral", plugins: [wasmGate(found)] });
  await writeFile(wasmFileFor(outfile), found.wasm);
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
  const command = join(outdir, "cli.js");
  await buildLibrary(library);
  await buildCommand(command);
  for (const file of [library, wasmFileFor(library), command]) console.log(`${await sha256Of(file)}  ${basename(file)}`);
}
