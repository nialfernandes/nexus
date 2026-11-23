// The built library: ONE file that another repository can pin and check by its checksum, that runs with no Node built-in, and that works
// against the real server code, and libsodium's WebAssembly as a file beside it for a runtime that will not make code from bytes (a Cloudflare
// Worker: worker.test.ts runs it in one). The build is run for real: `node scripts/build.mjs <outdir>` in a process of its own, the way
// `npm run build` runs it, and then the files it made are used.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLibrary, sha256Of, wasmFileFor } from "../scripts/build.mjs";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault } from "./world";
import { nexusTexts } from "../../../plugin/tests/world";

const PATH = "Agent/built.md";
const TEXT = "written by the built file\n";

/**
 * The SHA-256 of each file the build makes, pinned. Another repository copies nexus-agent.js and nexus-agent.wasm and pins these; a change
 * to what they hold, from a source, from @nexus/crypto or from libsodium, is a change to what that repository pinned, so it fails here until
 * someone has looked at it and written the new values in. The build prints them: `node scripts/build.mjs <outdir>`.
 */
const PINNED: Record<string, string> = {
  "nexus-agent.js": "ac5c8b91ff39b53774e2403fe785112d36ce9febc51208fd775379b0f8f11112",
  "nexus-agent.wasm": "29dd7daf12daec2afdf7b73101e50679bfe9c38861aa1f0de50ae505ccba99bd",
  "cli.js": "677d5ebd8b6171d7fb8abc68c41b08707d76de3713c361cf38090f6996459daf",
};

let directory = "";
let library = "";
let wasmFile = "";
let printed = "";
let bundle = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "nexus-agent-build-"));
  printed = execFileSync("node", [join(import.meta.dirname, "../scripts/build.mjs"), directory], { encoding: "utf8", cwd: join(import.meta.dirname, "..") });
  library = join(directory, "nexus-agent.js");
  wasmFile = wasmFileFor(library);
  bundle = readFileSync(library, "utf8");
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
});

describe("the build", () => {
  it("makes the library as one file, libsodium's WebAssembly beside it, and the command", () => {
    expect(readdirSync(directory).sort()).toEqual(["cli.js", "nexus-agent.js", "nexus-agent.wasm"]);
    expect(statSync(library).size, "libsodium's WebAssembly is inside").toBeGreaterThan(100_000);
    expect(bundle).toMatch(/^export \{/m);
  });

  it("prints the SHA-256 of each file in the form `sha256sum -c` reads, and they are the files'", async () => {
    const sums = ["nexus-agent.js", "nexus-agent.wasm", "cli.js"].map((name) => `${createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")}  ${name}\n`);
    expect(printed).toBe(sums.join(""));
    expect(await sha256Of(library)).toBe(sums[0]!.slice(0, 64));
    // Another repository checks the files it pinned the same way.
    expect(() => execFileSync("sha256sum", ["-c"], { input: printed, cwd: directory, stdio: ["pipe", "pipe", "pipe"] })).not.toThrow();
  });

  it("makes the files whose checksums are pinned in this test", () => {
    const printedSums = Object.fromEntries(printed.trim().split("\n").map((line) => line.split("  ").reverse() as [string, string]));
    expect(printedSums, "the build printed the pinned files' checksums: if this fails on purpose, the new values are the printed ones").toEqual(PINNED);
  });

  it("is named by the package: it ships in dist, and `@nexus/agent/nexus-agent.wasm` is the file the build wrote", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { files: string[]; exports: Record<string, unknown> };
    expect(manifest.files).toContain("dist");
    expect(manifest.exports["./nexus-agent.wasm"]).toBe(`./dist/${basename(wasmFile)}`);
  });

  it("writes the WebAssembly beside the library as a module of its own, and it is the very bytes that are inside the library", () => {
    const bytes = readFileSync(wasmFile);
    expect([...bytes.subarray(0, 4)], "the magic number of a WebAssembly module").toEqual([0, 0x61, 0x73, 0x6d]);
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(200_000);
    expect(bundle, "the library holds the same bytes as base64, for a runtime that can start them").toContain(bytes.toString("base64"));
  });

  it("makes the same file every time, so a checksum taken from one build is every build's", async () => {
    const again = mkdtempSync(join(tmpdir(), "nexus-agent-build-again-"));
    try {
      await buildLibrary(join(again, "nexus-agent.js"));
      expect(await sha256Of(join(again, "nexus-agent.js"))).toBe(await sha256Of(library));
      expect(await sha256Of(join(again, "nexus-agent.wasm"))).toBe(await sha256Of(wasmFile));
    } finally {
      rmSync(again, { recursive: true });
    }
  });

  it("imports nothing: no import statement, no dynamic import, no require, no import.meta", () => {
    expect(bundle).not.toMatch(/^\s*import\b[^\n]*["'][^"']+["']/m);
    expect(bundle).not.toMatch(/^\s*export\b[^\n]*\bfrom\s*["']/m);
    expect(bundle).not.toMatch(/\bimport\s*\(/);
    expect(bundle).not.toMatch(/\brequire\s*\(/);
    expect(bundle).not.toMatch(/\bimport\.meta\b/);
  });

  it("names no Node module and does not use WebCrypto's SubtleCrypto", () => {
    expect(bundle).not.toMatch(/node:/);
    const builtins = "fs|path|os|crypto|util|buffer|stream|events|url|module|http|https|net|tls|dns|zlib|assert|vm|readline|worker_threads|child_process";
    expect(bundle).not.toMatch(new RegExp(`["'](${builtins})["']`));
    expect(bundle).not.toMatch(/\bsubtle\b/i);
  });

  it("is a file that can be pinned: its public functions are all it exports", async () => {
    const built = await import(/* @vite-ignore */ pathToFileURL(library).href);
    expect(Object.keys(built).sort()).toEqual(["AgentError", "AgentVault", "isSafeNotePath", "openAgentVault"]);
  });

  it("opens an approval and round-trips a note against the real server code", async () => {
    const built = await import(/* @vite-ignore */ pathToFileURL(library).href);
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { fetch } = fetchOverNexus();
    const vault = await built.openAgentVault({ ...credentials, fetch });
    expect(vault.vaultId).toBe(world.keys.vaultId);
    await vault.write(PATH, TEXT);
    expect(await vault.read(PATH)).toBe(TEXT);
    expect(await vault.list()).toEqual([PATH]);
    expect(await nexusTexts(world), "what the server holds opens with the vault key, as the plugin opens it").toEqual({ [PATH]: TEXT });
    await expect(built.openAgentVault({ ...credentials, privateKey: credentials.publicKey, fetch })).rejects.toMatchObject({ name: "AgentError", code: "bad-approval" });
    vault.close();
  });
});

describe("the built file in a Worker-like runtime", () => {
  /**
   * The built file is an ES module and a Worker loads it as one. Node's test runner cannot load a module without Node's globals, so the
   * file's one `export { ... }` line is turned into an assignment and the file is run as a script in a fresh V8 context that has only
   * what a Cloudflare Worker has: the web platform (crypto.getRandomValues, fetch, TextEncoder, atob, btoa, URL, timers, WebAssembly)
   * and none of Node's: no `require`, `process`, `Buffer` or `module`. Nothing else of the file is changed.
   */
  function loadInWorkerLikeContext(fetch: unknown, wasmFromBytes = true) {
    const exported = /\nexport \{([^}]*)\};?\s*$/.exec(bundle);
    expect(exported, "the file ends with one export list").not.toBeNull();
    const names = exported![1]!.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const [inner, outer = inner] = part.split(/\s+as\s+/) as [string, string?];
      return `${outer}: ${inner}`;
    });
    const script = `${bundle.slice(0, exported!.index)}\nglobalThis.__exports = { ${names.join(", ")} };\n`;

    const sandbox: Record<string, unknown> = {
      // Random bytes from the host, filled into the context's own array.
      crypto: {
        getRandomValues: (array: Uint8Array) => {
          const bytes = new Uint8Array(array.length);
          globalThis.crypto.getRandomValues(bytes);
          array.set(bytes);
          return array;
        },
      },
      fetch, TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, setTimeout, clearTimeout, console,
    };
    // A Worker refuses to make WebAssembly from bytes and takes a module that was compiled before it started.
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: wasmFromBytes } });
    vm.runInContext(script, context, { filename: "nexus-agent.js" });
    return { context, api: (sandbox.__exports as Record<string, any>) ?? vm.runInContext("globalThis.__exports", context) };
  }

  it("has none of Node's globals, and the file runs there", () => {
    const { context } = loadInWorkerLikeContext(async () => ({ status: 200, text: async () => "{}" }));
    for (const name of ["require", "process", "Buffer", "module", "exports", "__dirname", "setImmediate"]) {
      expect(vm.runInContext(`typeof ${name}`, context), name).toBe("undefined");
    }
    expect(vm.runInContext("typeof WebAssembly + typeof crypto.getRandomValues + typeof fetch", context)).toBe("objectfunctionfunction");
  });

  it("opens an approval and round-trips a note against the real server code, with nothing but the web platform", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { fetch, seen } = fetchOverNexus();
    const { context } = loadInWorkerLikeContext(fetch);
    const api = vm.runInContext("globalThis.__exports", context) as Record<string, any>;

    // The key and the approval are strings, as a Worker's secrets are: nothing crosses into the context that is not plain text.
    const vault = await api.AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch });
    expect(vault.vaultId).toBe(world.keys.vaultId);
    expect(JSON.parse(JSON.stringify(await vault.write(PATH, TEXT)))).toEqual({ path: PATH, version: 1, saved: true, merged: false, duplicate: false });
    expect(await vault.read(PATH)).toBe(TEXT);
    expect(await vault.list()).toEqual([PATH]);
    expect(await nexusTexts(world), "the server holds it as the plugin's format").toEqual({ [PATH]: TEXT });
    await vault.remove(PATH);
    expect(await vault.list()).toEqual([]);
    vault.close();
    expect(seen.length).toBeGreaterThan(3);

    // A wrong key is refused there too, with the library's own plain error.
    await expect(api.AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.publicKey, approval: credentials.approval, fetch }))
      .rejects.toMatchObject({ name: "AgentError", code: "bad-approval" });
  });

  it("cannot start libsodium there when WebAssembly may not be made from bytes, and no module is given: the rule a Worker has", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { fetch } = fetchOverNexus();
    const { context } = loadInWorkerLikeContext(fetch, false);
    const api = vm.runInContext("globalThis.__exports", context) as Record<string, any>;
    await expect(api.AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch })).rejects.toThrow(/wasm|WebAssembly/i);
  });

  it("starts there with the .wasm file compiled beforehand and given as `wasm`, and opens an approval and round-trips a note", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { fetch } = fetchOverNexus();
    const { context } = loadInWorkerLikeContext(fetch, false);
    const api = vm.runInContext("globalThis.__exports", context) as Record<string, any>;
    // Compiled out here, where compiling is allowed, as a Worker's own start-up does with the file it imports.
    const wasm = new WebAssembly.Module(readFileSync(wasmFile));

    const vault = await api.AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch, wasm });
    await vault.write(PATH, TEXT);
    expect(await vault.read(PATH)).toBe(TEXT);
    expect(await nexusTexts(world)).toEqual({ [PATH]: TEXT });
    vault.close();
  });

  it("refuses a `wasm` that is not a compiled module, before it starts anything", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { fetch } = fetchOverNexus();
    const { context } = loadInWorkerLikeContext(fetch);
    const api = vm.runInContext("globalThis.__exports", context) as Record<string, any>;
    await expect(api.AgentVault.open({ ...credentials, fetch, wasm: readFileSync(wasmFile) })).rejects.toMatchObject({ name: "AgentError", code: "bad-settings" });
    await expect(api.AgentVault.connect({ ...credentials, fetch, wasm: "not a module" })).rejects.toMatchObject({ name: "AgentError", code: "bad-settings" });
    // The refusals started nothing, so a call with no module still starts from the bytes inside the file.
    const vault = await api.AgentVault.open({ ...credentials, fetch });
    expect(vault.vaultId).toBe(world.keys.vaultId);
    vault.close();
  });
});
