// The built command, run as a program of its own the way `npm run build` makes it: `node scripts/build.mjs <outdir>` in a process, then the file it made.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory = "";
let printed = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "nexus-linker-build-"));
  printed = execFileSync("node", [join(import.meta.dirname, "../scripts/build.mjs"), directory], { encoding: "utf8", cwd: join(import.meta.dirname, "..") });
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
});

describe("the build", () => {
  it("makes the command, the Worker and the WebAssembly the Worker imports, and prints the SHA-256 of each", () => {
    expect(readdirSync(directory).sort()).toEqual(["cli.js", "nexus-agent.wasm", "worker.js"]);
    const sums = ["cli.js", "worker.js", "nexus-agent.wasm"].map((name) => `${createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")}  ${name}\n`);
    expect(printed).toBe(sums.join(""));
  });

  it("makes the Worker a module that imports only the WebAssembly beside it", () => {
    const worker = readFileSync(join(directory, "worker.js"), "utf8");
    expect([...worker.matchAll(/^import\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map((match) => match[1])).toEqual(["./nexus-agent.wasm"]);
    expect(worker).toMatch(/\bscheduled\b/);
    expect(worker).not.toMatch(/\brequire\(|node:/);
  });

  it("makes a command that runs: it says its usage, and stops with a plain message when its settings are missing", () => {
    const cli = join(directory, "cli.js");
    expect(statSync(cli).mode & 0o111, "it can be run").not.toBe(0);
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: {} });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("nexus-linker run");
    const noSettings = spawnSync(process.execPath, [cli, "run"], { encoding: "utf8", env: {} });
    expect(noSettings.status).toBe(1);
    expect(noSettings.stderr).toMatch(/^Set LINKER_FOLDERS, LINKER_MODEL_ADDRESS, LINKER_MODEL_KEY, LINKER_MODEL_NAME first/);
    expect(basename(cli)).toBe("cli.js");
  });
});
