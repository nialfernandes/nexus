// Loads the built main.js the way Obsidian does, but under Node, and gives back
// what the plugin exports. Nothing here reaches into src/: it runs the bundle.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInContext, createContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { buildProbe } from "../esbuild.config.mjs";
import type { HostInfo, ProbeReport, RunProbeOptions } from "../src/probe";

export interface LoadedBundle {
  runProbe: (options?: RunProbeOptions) => Promise<ProbeReport>;
  /** Every module name the bundle asked require() for while it loaded. */
  requested: string[];
}

export interface LoadOptions {
  /** Take the WebAssembly object away, as Lockdown Mode on an iPhone does. */
  withoutWebAssembly?: boolean;
}

/** A stand-in for the part of "obsidian" the bundle touches while loading. */
const obsidianStub = {
  Plugin: class {},
  Modal: class {},
  Notice: class {},
  Platform: {},
  apiVersion: "test",
};

export const TEST_HOST: HostInfo = { obsidianVersion: "test", platform: { isDesktop: true } };

/** Builds the bundle into a scratch folder and returns the folder. */
export async function buildToScratch(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "nexus-probe-"));
  await buildProbe(outDir);
  return outDir;
}

export function loadBundle(builtDir: string, options: LoadOptions = {}): LoadedBundle {
  const code = readFileSync(join(builtDir, "main.js"), "utf8");
  const requested: string[] = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    hostEncode: (text: string): number[] => Array.from(new TextEncoder().encode(text)),
    URL,
    navigator: { userAgent: "node-test", hardwareConcurrency: 1 },
    crypto: webcrypto,
  };
  const context = createContext(sandbox);
  // A page's global object is also called self; libsodium looks for crypto there.
  runInContext("globalThis.self = globalThis;", context);
  // A browser's TextEncoder gives back arrays of the page's own Uint8Array, and
  // libsodium checks that. Node's gives the outer one, so wrap it.
  runInContext(
    `globalThis.TextEncoder = class { encode(text) { return Uint8Array.from(hostEncode(text)); } };`,
    context,
  );
  if (options.withoutWebAssembly) runInContext("delete globalThis.WebAssembly;", context);

  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string): unknown => {
    requested.push(name);
    if (name === "obsidian") return obsidianStub;
    throw new Error(`the bundle asked for "${name}", which Obsidian would not give it`);
  };
  const wrapper = runInContext(`(function (module, exports, require) {${code}\n})`, context, {
    filename: "main.js",
  }) as (m: unknown, e: unknown, r: unknown) => void;
  wrapper(module, module.exports, require);

  const plugin = module.exports.default as { runProbe: LoadedBundle["runProbe"] };
  return { runProbe: plugin.runProbe, requested };
}
