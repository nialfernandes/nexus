// The built library in a real Worker runtime: workerd, which Cloudflare's Workers run on, started by Miniflare. A Worker refuses to make
// code from bytes ("Wasm code generation disallowed by embedder"), which libsodium inside the library does by default; the build writes the
// WebAssembly as a file beside the library and the library takes it as a compiled module. The V8 context in build.test.ts allows what a
// Worker does not, so it never met that rule: this file does.
//
// The Worker is tests/worker/first-note.mjs. The built files are the ones `node scripts/build.mjs` makes, run in a process of its own.
// The Worker has no network: its calls to Nexus (`outboundService`) are handed to the server's own routes, as the Node tests' are
// (world.ts), and what the Worker saved is read back with the plugin's own engine.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDevice, nexusNotes, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials } from "./world";

const PATH = "Agent/2026-11-15 First.md";

let directory = "";
let scratch = "";
let library = "";
let wasm = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "nexus-agent-worker-"));
  scratch = mkdtempSync(join(tmpdir(), "nexus-agent-worker-state-"));
  execFileSync("node", [join(import.meta.dirname, "../scripts/build.mjs"), directory], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  library = readFileSync(join(directory, "nexus-agent.js"), "utf8");
  wasm = join(directory, "nexus-agent.wasm");
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
  if (scratch) rmSync(scratch, { recursive: true });
});

/** A Worker runtime (workerd) with the first-note Worker in it, whose calls to Nexus go to the server's own code. Its isolate is its own. */
function startWorker(credentials: AgentCredentials): { worker: Miniflare; seen: ReturnType<typeof fetchOverNexus>["seen"] } {
  const { fetch, seen } = fetchOverNexus();
  const worker = new Miniflare({
    modules: [
      { type: "ESModule", path: "first-note.mjs", contents: readFileSync(join(import.meta.dirname, "worker/first-note.mjs"), "utf8") },
      { type: "ESModule", path: "nexus-agent.js", contents: library },
      { type: "CompiledWasm", path: "nexus-agent.wasm", contents: readFileSync(wasm) },
    ],
    // A Worker's secrets are strings.
    bindings: { ADDRESS, TOKEN: credentials.token, PRIVATE_KEY: credentials.privateKey, APPROVAL: credentials.approval },
    // No Node compatibility, as a Worker with only the web platform.
    compatibilityDate: "2026-07-01",
    cf: false,
    defaultPersistRoot: scratch,
    outboundService: async (request: Request) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => (headers[name] = value));
      const answer = await fetch(request.url, {
        method: request.method,
        headers,
        ...(request.method === "GET" ? {} : { body: await request.text() }),
      });
      return new Response(await answer.text(), { status: answer.status, headers: { "content-type": "application/json" } });
    },
  });
  return { worker, seen };
}

describe("the built library in a Worker runtime", () => {
  it("starts there with the .wasm file as a module: opens an approval, creates a note, updates it by id at its version, and a second update at the old version answers changed-since", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { worker } = startWorker(credentials);
    try {
      const answer = await worker.dispatchFetch("http://worker.test/");
      const body = (await answer.json()) as Record<string, any>;
      expect(answer.status, JSON.stringify(body)).toBe(200);

      expect(body.created).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), path: PATH, version: 1 });
      expect(body.updated).toEqual({ result: "saved", id: body.created.id, path: PATH, version: 2 });
      expect(body.stale, "the update from the old version").toEqual({ result: "changed-since", id: body.created.id, current: 2 });
      expect(body.read).toEqual({ id: body.created.id, path: PATH, version: 2, text: "# First\n\nSecond line.\n" });
      // The same Worker, opening the vault and going by path.
      expect(body.listed).toEqual([{ path: PATH, id: body.created.id, version: 2 }]);
      expect(body.text).toBe("# First\n\nSecond line.\n");
      expect(body.written).toEqual({ path: "Agent/2026-11-15 Second.md", version: 1, saved: true, merged: false, duplicate: false });

      // What the Worker saved is the plugin's format: the stale update changed nothing, and the plugin's own engine reads the note.
      expect((await nexusNotes(world))[body.created.id]).toEqual({ path: PATH, text: "# First\n\nSecond line.\n", version: 2 });
      expect(await nexusTexts(world)).toEqual({ [PATH]: "# First\n\nSecond line.\n", "Agent/2026-11-15 Second.md": "# Second\n" });
      const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
      await device.engine.sync();
      expect(device.vault.textOf(PATH)).toBe("# First\n\nSecond line.\n");
      expect(device.vault.textOf("Agent/2026-11-15 Second.md")).toBe("# Second\n");
    } finally {
      await worker.dispose();
    }
  }, 120_000);

  it("is refused by the Worker runtime when it is not given the module, which is what the V8 context could not show", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);
    const { worker } = startWorker(credentials);
    try {
      const body = (await (await worker.dispatchFetch("http://worker.test/without-the-module")).json()) as Record<string, any>;
      expect(body.opened).toBe(false);
      expect(body.message).toMatch(/Wasm code generation disallowed by embedder/);
    } finally {
      await worker.dispose();
    }
  }, 120_000);
});
