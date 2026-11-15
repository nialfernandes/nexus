// The library has no Node of its own and no way to put a key anywhere: its source (every file directly in src/, which is what the built
// file is made from) uses no Node module, no file, no process, no console and no storage. The command (src/cli/) is the only part that does.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = new URL("../src/", import.meta.url).pathname;
const library = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"));
const command = readdirSync(join(sourceDirectory, "cli")).filter((name) => name.endsWith(".ts"));

/** Comments are prose and may name these things; the code may not use them. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const forbidden: Array<[string, RegExp]> = [
  ["a Node module", /\bfrom\s+["'](node:|fs|path|os|crypto|buffer|util|stream|child_process|readline)/],
  ["require", /\brequire\s*\(/],
  ["Buffer", /\bBuffer\b/],
  ["process", /\bprocess\./],
  ["WebCrypto's subtle", /\bsubtle\b/],
  ["the console", /\bconsole\./],
  ["storage", /\b(localStorage|sessionStorage|indexedDB)\b/],
  ["a file", /\b(readFile|writeFile|appendFile|createWriteStream)\b/],
  ["Math.random", /\bMath\.random\b/],
  ["a timer", /\b(setTimeout|setInterval)\b/],
];

describe("the library's source", () => {
  it("finds the files", () => {
    expect(library.sort()).toEqual(["base64.ts", "errors.ts", "index.ts", "nexus.ts", "paths.ts", "setup.ts", "vault.ts", "wasm-gate.ts"]);
  });

  for (const [what, pattern] of forbidden) {
    it(`does not use ${what}`, () => {
      for (const file of library) expect(withoutComments(readFileSync(join(sourceDirectory, file), "utf8")), file).not.toMatch(pattern);
    });
  }

  it("takes its randomness only from the runtime's crypto, for a note's id and a new vault's id, and from libsodium for everything else", () => {
    for (const file of library) {
      const code = withoutComments(readFileSync(join(sourceDirectory, file), "utf8"));
      const uses = code.match(/getRandomValues/g)?.length ?? 0;
      expect(uses, file).toBe(file === "vault.ts" || file === "setup.ts" ? 1 : 0);
    }
  });

  it("imports only the encryption, the merge and itself", () => {
    for (const file of library) {
      for (const [, from] of readFileSync(join(sourceDirectory, file), "utf8").matchAll(/^import\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)) {
        expect(from, file).toMatch(/^(@nexus\/crypto|@nexus\/merge|\.\/[a-z0-9-]+)$/);
      }
    }
  });
});

describe("the command's source", () => {
  it("never reads a key from the command line: it reads no process.argv beyond bin.ts, which hands the arguments over, and names no key flag", () => {
    for (const file of command) {
      const code = withoutComments(readFileSync(join(sourceDirectory, "cli", file), "utf8"));
      if (file !== "bin.ts") expect(code, file).not.toMatch(/process\.argv/);
      expect(code, file).not.toMatch(/--(private|recovery|key|token|approval)/i);
    }
  });

  it("writes no file", () => {
    for (const file of command) expect(withoutComments(readFileSync(join(sourceDirectory, "cli", file), "utf8")), file).not.toMatch(/\b(readFile|writeFile|appendFile|createWriteStream|mkdir)\b/);
  });
});
