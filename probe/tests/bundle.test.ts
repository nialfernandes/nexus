import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildToScratch } from "./load-bundle";

const probeDir = join(__dirname, "..");
let built: string;

beforeAll(async () => {
  built = await buildToScratch();
}, 60_000);

describe("the built plugin file", () => {
  it("asks for no module except obsidian, and has no Node or Electron import", () => {
    const code = readFileSync(join(built, "main.js"), "utf8");

    const required = [...code.matchAll(/\brequire\(\s*(["'`])([^"'`]*)\1\s*\)/g)].map((m) => m[2]);
    expect(new Set(required)).toEqual(new Set(["obsidian"]));

    expect(code).not.toMatch(/require\(\s*["'`](?:node:|electron)/);
    expect(code).not.toMatch(/\bfrom\s*["'`](?:node:|electron)/);
    expect(code).not.toMatch(/\bimport\(\s*["'`]/);
    expect(code).not.toMatch(/\bimport\.meta\b/);
    for (const name of ["fs", "path", "os", "crypto", "child_process", "worker_threads", "module"]) {
      expect(code, `a require of ${name}`).not.toMatch(new RegExp(`require\\(\\s*["'\`]${name}["'\`]`));
    }
  });

  it("is the same file that is committed in dist/, with the same manifest", () => {
    const fresh = readFileSync(join(built, "main.js"));
    const committed = readFileSync(join(probeDir, "dist", "main.js"));
    expect(committed.equals(fresh), "dist/main.js is out of date: run npm run build").toBe(true);

    const manifest = readFileSync(join(probeDir, "manifest.json"));
    expect(readFileSync(join(probeDir, "dist", "manifest.json")).equals(manifest)).toBe(true);
  });

  it("has a manifest Obsidian and BRAT can read", () => {
    const manifest = JSON.parse(readFileSync(join(probeDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.id).toBe("nexus-probe");
    expect(manifest.isDesktopOnly).toBe(false);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const key of ["name", "version", "minAppVersion", "description", "author"]) {
      expect(typeof manifest[key], key).toBe("string");
    }
  });
});
