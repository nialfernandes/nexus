// The built Worker in a real Worker runtime (workerd, started by Miniflare), woken the way a cron trigger wakes it. The Worker has no
// network of its own here: its calls to Nexus go to the server's own code and its calls to the model go to the stand-in model server,
// as the agent's Worker test does it. What it saved is read back with the plugin's own way of reading.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { API, ORIGIN } from "../../../plugin/tests/real-nexus";
import { buildWorker } from "../scripts/build.mjs";
import { MENTIONS_FOLDER } from "../src/titles";
import { hushPath, transcriptNote } from "./fixtures";
import { listOf, openLab, type Lab } from "./lab";

let directory = "";
let scratch = "";

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nexus-linker-worker-"));
  scratch = mkdtempSync(join(tmpdir(), "nexus-linker-worker-state-"));
  await buildWorker(join(directory, "worker.js"));
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
  if (scratch) rmSync(scratch, { recursive: true });
});

const toDispose: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of toDispose.splice(0)) await dispose();
});

/** The Worker, with the lab's settings as its bindings and the lab's two servers behind its outbound calls. */
function startWorker(l: Lab, env: Record<string, string>, more: Record<string, unknown> = {}): { worker: Miniflare; printed: string[] } {
  const printed: string[] = [];
  const worker = new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.js", contents: readFileSync(join(directory, "worker.js"), "utf8") },
      { type: "CompiledWasm", path: "nexus-agent.wasm", contents: readFileSync(join(directory, "nexus-agent.wasm")) },
    ],
    // A Worker's settings are strings, its secrets are too.
    bindings: env,
    ...more,
    compatibilityDate: "2026-07-01",
    cf: false,
    defaultPersistRoot: scratch,
    handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
      for (const stream of [stdout, stderr]) stream.on("data", (chunk: Buffer) => printed.push(chunk.toString("utf8")));
    },
    outboundService: async (request: Request) => {
      if (request.url.startsWith(ORIGIN + API)) {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, name) => (headers[name] = value));
        const answer = await l.fetchNexus(request.url, { method: request.method, headers, ...(request.method === "GET" ? {} : { body: await request.text() }) });
        return new Response(await answer.text(), { status: answer.status, headers: { "content-type": "application/json" } });
      }
      // The stand-in model server is on a port of this machine.
      const headers = new Headers(request.headers);
      // Node's own fetch works out the length of the body it is given.
      headers.delete("content-length");
      return fetch(request.url, { method: request.method, headers, ...(request.method === "GET" ? {} : { body: await request.text() }) });
    },
  });
  toDispose.push(() => worker.dispose());
  return { worker, printed };
}

describe("the built Worker, woken by a cron trigger", () => {
  it("links the transcript notes and leaves nothing for a second trigger to do", async () => {
    const l = await openLab();
    toDispose.push(() => l.close());
    await l.seed(hushPath("A link"), transcriptNote({ title: "A link", description: "Atomic Habits by James Clear.", links: ["https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299"], spoken: ["Hello."] }));
    await l.seed(hushPath("B spoken"), transcriptNote({ title: "B spoken", spoken: ["Atomic Habits by James Clear, a good one."] }));
    l.model.answer((transcript) => (transcript.includes("a good one") ? listOf({ type: "book", title: "Atomic Habits", author: "James Clear" }) : "[]"));

    const { worker, printed } = startWorker(l, l.env);
    const scheduled = await (await worker.getWorker()).scheduled({ cron: "*/15 * * * *" });
    expect(scheduled.outcome).toBe("ok");

    const texts = await l.texts();
    expect(Object.keys(texts).filter((path) => path.startsWith(MENTIONS_FOLDER)).sort()).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    expect(texts["Mentions/Atomic Habits.md"]).toBe('---\ntype: book\nurl: "https://www.amazon.com/dp/0735211299"\nauthor: "[[James Clear]]"\n---\n');
    for (const name of ["A link", "B spoken"]) {
      expect(texts[hushPath(name)]).toContain("## Mentions\n\n- [[Atomic Habits]]\n");
      expect(texts[hushPath(name)]).toContain("mentions: linked");
    }
    expect(l.model.asked).toHaveLength(2);
    // The key is a plain secret here: a string, sent to the model as it is.
    expect(l.model.asked.every((asked) => asked.authorization === `Bearer ${l.env.LINKER_MODEL_KEY}`)).toBe(true);
    // The Worker says what it did in its log, and the log holds no key.
    const log = printed.join("");
    expect(log).toContain("Linked 2 of 2 notes taken on.");
    for (const secret of [l.credentials.token, l.credentials.privateKey, l.credentials.approval, l.env.LINKER_MODEL_KEY!]) expect(log).not.toContain(secret);

    const before = await l.refs();
    expect((await (await worker.getWorker()).scheduled({ cron: "*/15 * * * *" })).outcome).toBe("ok");
    expect(await l.refs()).toEqual(before);
    expect(l.model.asked).toHaveLength(2);
  }, 120_000);

  /** The Worker with the model's key as a Secrets Store binding, which holds `key` when it is given one. */
  async function startWithKeyInAStore(l: Lab, key: string | null): Promise<ReturnType<typeof startWorker>> {
    const { LINKER_MODEL_KEY: _plain, ...without } = l.env;
    const started = startWorker(l, without, {
      secretsStoreSecrets: { LINKER_MODEL_KEY: { store_id: "a-store-of-the-example", secret_name: "linker-model-key" } },
      secretsStorePersist: join(scratch, `secrets-${Math.random().toString(36).slice(2)}`),
    });
    if (key !== null) await (await started.worker.getSecretsStoreSecretAPI("LINKER_MODEL_KEY"))().create(key);
    return started;
  }

  it("takes the model's key from a Secrets Store binding, an object whose get() answers it, as it takes a plain secret", async () => {
    const l = await openLab();
    toDispose.push(() => l.close());
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Atomic Habits by James Clear, a good one."] }));
    l.model.answer(() => listOf({ type: "book", title: "Atomic Habits" }));
    const key = "a-key-from-the-store";

    const { worker, printed } = await startWithKeyInAStore(l, key);
    expect((await (await worker.getWorker()).scheduled({ cron: "*/15 * * * *" })).outcome).toBe("ok");

    expect(l.model.asked).toHaveLength(1);
    expect(l.model.asked[0]!.authorization).toBe(`Bearer ${key}`);
    expect((await l.texts())[hushPath("One")]).toContain("- [[Atomic Habits]]\n");
    expect(printed.join("")).not.toContain(key);
  }, 120_000);

  it("fails the trigger, and writes nothing, when the Secrets Store binding has no key to give", async () => {
    const l = await openLab();
    toDispose.push(() => l.close());
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Hello."] }));
    const { worker } = await startWithKeyInAStore(l, null);
    const before = await l.refs();
    expect((await (await worker.getWorker()).scheduled({ cron: "*/15 * * * *" })).outcome).toBe("exception");
    expect(await l.refs()).toEqual(before);
    expect(l.model.asked).toHaveLength(0);
  }, 120_000);

  it("fails the trigger, and writes nothing, when a setting is missing", async () => {
    const l = await openLab();
    toDispose.push(() => l.close());
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Hello."] }));
    const { LINKER_MODEL_NAME: _left, ...without } = l.env;
    const { worker } = startWorker(l, without);
    const before = await l.refs();
    expect((await (await worker.getWorker()).scheduled({ cron: "*/15 * * * *" })).outcome).toBe("exception");
    expect(await l.refs()).toEqual(before);
    expect(l.model.asked).toHaveLength(0);
  }, 120_000);

  it("answers no web request: it only wakes on its schedule", async () => {
    const l = await openLab();
    toDispose.push(() => l.close());
    const { worker } = startWorker(l, l.env);
    const answer = await worker.dispatchFetch("http://worker.test/");
    expect(answer.ok).toBe(false);
    await answer.text();
    expect(l.model.asked).toHaveLength(0);
  }, 120_000);
});
