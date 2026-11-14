import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"));

/** Comments are prose and may name these things; the code may not use them. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const forbidden: Array<[string, RegExp]> = [
  ["a Node module", /\bfrom\s+["'](node:|fs|path|os|crypto|buffer|util|stream)/],
  ["require", /\brequire\s*\(/],
  ["Buffer", /\bBuffer\b/],
  ["process", /\bprocess\./],
  ["WebCrypto's subtle", /\bsubtle\b/],
  ["a clock", /\b(Date\.now|new Date|performance\.now|setTimeout|setInterval)\b/],
  ["Math.random", /\bMath\.random\b/],
  ["the network", /\b(fetch|XMLHttpRequest|WebSocket)\b/],
  ["storage", /\b(localStorage|sessionStorage|indexedDB)\b/],
  ["the console", /\bconsole\./],
];

describe("the source has no input or output of its own", () => {
  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const [what, pattern] of forbidden) {
    it(`does not use ${what}`, () => {
      for (const file of files) {
        const code = withoutComments(readFileSync(join(sourceDirectory, file), "utf8"));
        expect(code, file).not.toMatch(pattern);
      }
    });
  }

  it("takes its randomness only from libsodium", () => {
    for (const file of files) {
      const code = withoutComments(readFileSync(join(sourceDirectory, file), "utf8"));
      expect(code, file).not.toMatch(/getRandomValues/);
    }
  });
});
