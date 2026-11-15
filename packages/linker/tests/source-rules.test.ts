// What the job's source may not do. The job runs in a Cloudflare Worker, so apart from the three files that meet the outside (the Worker's
// entry, the command and the program that starts it) it uses no Node module, no process and no console. It has no call that deletes a note.
// And a public repository names no maker of a model and no app of ours: a model is a setting.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = new URL("../", import.meta.url).pathname;
const sourceDirectory = join(here, "src");
const files = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"));
/** The files that meet the outside: they may name the console and the process. */
const outside = ["bin.ts", "command.ts", "worker.ts"];
const inside = files.filter((name) => !outside.includes(name));

/** Comments are prose and may name these things; the code may not use them. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (name: string): string => withoutComments(readFileSync(join(sourceDirectory, name), "utf8"));

describe("the job's source", () => {
  it("finds the files", () => {
    expect(files.sort()).toEqual(["bin.ts", "command.ts", "index.ts", "job.ts", "mention.ts", "mentions.ts", "model.ts", "note-text.ts", "run.ts", "settings.ts", "show-notes.ts", "store.ts", "titles.ts", "wasm.d.ts", "worker.ts"]);
  });

  for (const [what, pattern] of [
    ["a Node module", /\bfrom\s+["'](node:|fs|path|os|crypto|buffer|util|stream|child_process|readline)/],
    ["require", /\brequire\s*\(/],
    ["Buffer", /\bBuffer\b/],
    ["process", /\bprocess\./],
    ["the console", /\bconsole\./],
    ["a file", /\b(readFile|writeFile|appendFile|createWriteStream)\b/],
    ["Math.random", /\bMath\.random\b/],
    ["a timer", /\b(setTimeout|setInterval)\b/],
  ] as const) {
    it(`does not use ${what}, apart from the files that meet the outside`, () => {
      for (const name of inside) expect(code(name), name).not.toMatch(pattern);
    });
  }

  it("lets only the Worker's entry write to a console, and only the program that starts the command read the process", () => {
    expect(files.filter((name) => /\bconsole\./.test(code(name)))).toEqual(["worker.ts"]);
    expect(files.filter((name) => /\bprocess\./.test(code(name)))).toEqual(["bin.ts"]);
  });

  it("has no call that deletes a note, and never reaches the vault but through the four calls the store names", () => {
    for (const name of files) expect(code(name), name).not.toMatch(/\.remove\(|\bremove\b\s*\(|["']delete["']/);
    // The agent's calls by path (`write`, `read`, `list`) are not used: the job goes by note id. (The command's own output has a `write`.)
    for (const name of inside) expect(code(name), name).not.toMatch(/\.write\(|\.read\(|\.list\(/);
    const used = new Set(files.flatMap((name) => [...code(name).matchAll(/\bstore\.(\w+)\(|\bthis\.#store\.(\w+)\(/g)].map((match) => match[1] ?? match[2])));
    expect([...used].sort()).toEqual(["createNote", "listNotes", "readNote", "updateNote"]);
  });

  it("imports only the agent library, the Worker's WebAssembly and itself", () => {
    for (const name of files) {
      for (const [, from] of readFileSync(join(sourceDirectory, name), "utf8").matchAll(/^import\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)) {
        expect(from, name).toMatch(/^(@nexus\/agent|@nexus\/agent\/nexus-agent\.wasm|\.\/[a-z0-9-]+)$/);
      }
    }
  });

  it("never reads a key from the command line", () => {
    expect(code("command.ts")).not.toMatch(/--(model-key|key|token|private|approval)/i);
    expect(code("command.ts")).not.toMatch(/process\.argv/);
  });
});

describe("what a public repository says", () => {
  const MAKERS_AND_APPS = /openai|anthropic|claude|\bgpt|gemini|mistral|llama|ollama|cohere|deepseek|hush|obsidian/i;

  it("names no maker of a model and no app of ours in the source, the README, the Worker's example or the package's own description", () => {
    const named = [
      ...files.map((name) => [`src/${name}`, readFileSync(join(sourceDirectory, name), "utf8")] as const),
      ["README.md", readFileSync(join(here, "README.md"), "utf8")],
      ["wrangler.example.toml", readFileSync(join(here, "wrangler.example.toml"), "utf8")],
      ["package.json", readFileSync(join(here, "package.json"), "utf8")],
    ];
    for (const [name, text] of named) expect(text, name).not.toMatch(MAKERS_AND_APPS);
  });

  it("has no default model: the model's name is read from a setting and written nowhere else", () => {
    expect(code("model.ts")).not.toMatch(/model:\s*["'`]/);
    expect(code("settings.ts")).not.toMatch(/name:\s*["'`]/);
    expect(code("job.ts")).not.toMatch(/\bname:\s*["'](?!linker)/);
  });
});
