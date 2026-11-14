// An app inside the same Worker does not use a token: it calls Nexus's store through an in-worker function with its
// own identity's name, and the same folder rights apply to it as to a token holder.
//
// THE FUNCTION. The Cloudflare plug exports `nexusAsApp(env, identity)` (the Worker's own bindings, and the
// identity's name). It gives back an object of the store's calls, each of which
// resolves with exactly the JSON the matching route sends in a 200 answer, and rejects, for what a route would
// refuse, with an Error whose `status` is the route's status and whose message is the route's `error`:
//
//   save(path, text, { base?, resolves? }?)   note(path, version?)   history(path)   list(folder?)
//   search(q)   changes(after?, limit?)   move(from, to)   remove(path)
//
// An identity the function is given that does not exist holds no rights: every call it makes is refused 403.

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { issueToken, listedPaths, manage, vaultAs, workerEnv, type Who } from "./__fixtures__/identity-world";
import { nexusAsApp } from "./plugs/cloudflare/app";

interface AppNexus {
  save(path: string, text: string, options?: { base?: number; resolves?: number }): Promise<any>;
  note(path: string, version?: number): Promise<any>;
  history(path: string): Promise<any>;
  list(folder?: string): Promise<any>;
  search(q: string): Promise<any>;
  changes(after?: string | number, limit?: number): Promise<any>;
  move(from: string, to: string): Promise<any>;
  remove(path: string): Promise<any>;
}

const asApp = async (identity: string): Promise<AppNexus> => nexusAsApp(workerEnv(), identity) as unknown as AppNexus;

/** What an in-worker call was refused with. A call that was not refused fails the test. */
async function refusal(call: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await call();
  } catch (error) {
    const e = error as { status?: unknown; message?: unknown };
    if (typeof e.status !== "number") throw error;
    return { status: e.status, message: String(e.message) };
  }
  return expect.fail("the call was not refused");
}

/** The status a call ends with: 200, or the status it was refused with. */
const statusOf = async (call: () => Promise<unknown>): Promise<number> => {
  try {
    await call();
    return 200;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status !== "number") throw error;
    return status;
  }
};

let ownerCookie: string;
let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
});

describe("recorder, inside the Worker, holds write on Podcasts/Transcripts/", () => {
  it("saves a transcript with no token, and the version's writer reads recorder", async () => {
    const recorder = await asApp("recorder");
    expect(await recorder.save("Podcasts/Transcripts/Ep 1.md", "Welcome to episode one.\n")).toMatchObject({
      result: "saved", path: "Podcasts/Transcripts/Ep 1.md", version: 1,
    });
    expect(bodyOf(await vaultAs(owner).note("Podcasts/Transcripts/Ep 1.md"))).toMatchObject({ writer: "recorder", text: "Welcome to episode one.\n" });
    expect(await recorder.note("Podcasts/Transcripts/Ep 1.md")).toMatchObject({ version: 1, writer: "recorder" });
    expect((await recorder.history("Podcasts/Transcripts/Ep 1.md")).versions).toHaveLength(1);
  });

  it("is refused 403, naming Ideas/a.md, for a save outside its folder, and nothing is kept", async () => {
    const recorder = await asApp("recorder");
    const refused = await refusal(() => recorder.save("Ideas/a.md", "not for recorder\n"));
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("Ideas/a.md");
    expect((await vaultAs(owner).note("Ideas/a.md")).status).toBe(404);
  });

  it("cannot read, move or delete outside its folder, whether or not the note is there", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/in-worker.md", "owner's\n"));
    const recorder = await asApp("recorder");
    for (const [what, call, path] of [
      ["a read", () => recorder.note("Ideas/in-worker.md"), "Ideas/in-worker.md"],
      ["a read of a note that is not there", () => recorder.note("Ideas/never.md"), "Ideas/never.md"],
      ["a history read", () => recorder.history("Ideas/in-worker.md"), "Ideas/in-worker.md"],
      ["a delete", () => recorder.remove("Ideas/in-worker.md"), "Ideas/in-worker.md"],
      ["a move out", () => recorder.move("Podcasts/Transcripts/Ep 1.md", "Ideas/moved.md"), "Ideas/moved.md"],
    ] as const) {
      const refused = await refusal(call);
      expect(refused.status, what).toBe(403);
      expect(refused.message, what).toContain(path);
    }
    expect(bodyOf(await vaultAs(owner).note("Ideas/in-worker.md"))).toMatchObject({ version: 1, text: "owner's\n" });
  });

  it("lists, searches and sees in the changes feed only what is in its folder", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/in-worker-find.md", "tern-5521 outside\n"));
    const recorder = await asApp("recorder");
    await recorder.save("Podcasts/Transcripts/Ep 2.md", "tern-5521 inside\n");

    const listed = (await recorder.list()).notes.map((n: { path: string }) => n.path);
    expect(listed).toContain("Podcasts/Transcripts/Ep 2.md");
    expect(listed.filter((p: string) => !p.startsWith("Podcasts/Transcripts/"))).toEqual([]);
    expect((await recorder.search("tern-5521")).results.map((r: { path: string }) => r.path)).toEqual(["Podcasts/Transcripts/Ep 2.md"]);

    const feed = (await recorder.changes(undefined, 500)).changes.map((c: { path: string }) => c.path);
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.filter((p: string) => !p.startsWith("Podcasts/Transcripts/"))).toEqual([]);
  });
});

describe("agents, inside the Worker, hold write on everything except Private/", () => {
  it("saves outside Private/ as agents, and is refused inside it", async () => {
    const agents = await asApp("agents");
    expect(await agents.save("Ideas/in-worker-agents.md", "from inside\n")).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note("Ideas/in-worker-agents.md"))).toMatchObject({ writer: "agents" });
    bodyOf(await vaultAs(owner).save("Private/in-worker.md", "private\n"));
    const refused = await refusal(() => agents.note("Private/in-worker.md"));
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("Private/in-worker.md");
  });
});

describe("an app inside the Worker obeys the same rights as a token holder", () => {
  it("gets the same answer as a token for the same identity, call for call", async () => {
    bodyOf(await manage(owner).createIdentity("twin", "app", [
      { path: "Ideas/", access: "write" },
      { path: "Reference/", access: "read" },
      { path: "Ideas/Sealed/", access: "none" },
    ]));
    const token: Who = { bearer: (await issueToken(ownerCookie, "twin", "twin device")).token };
    const app = await asApp("twin");

    bodyOf(await vaultAs(owner).save("Reference/twin-ref.md", "twin-9037 reference\n"));
    bodyOf(await vaultAs(owner).save("Ideas/Sealed/twin-seal.md", "twin-9037 sealed\n"));
    bodyOf(await vaultAs(owner).save("Misc/twin-misc.md", "twin-9037 misc\n"));

    const viaToken = async (call: (v: ReturnType<typeof vaultAs>) => Promise<{ status: number }>) => (await call(vaultAs(token))).status;
    const viaApp = (call: () => Promise<unknown>) => statusOf(call);

    const same: Array<[string, number, number]> = [
      ["save into the writable folder", await viaToken((v) => v.save("Ideas/twin-new.md", "x\n")), await viaApp(() => app.save("Ideas/twin-new-app.md", "x\n"))],
      ["save into the read-only folder", await viaToken((v) => v.save("Reference/twin-new.md", "x\n")), await viaApp(() => app.save("Reference/twin-new-app.md", "x\n"))],
      ["save where no entry reaches", await viaToken((v) => v.save("Misc/twin-new.md", "x\n")), await viaApp(() => app.save("Misc/twin-new-app.md", "x\n"))],
      ["save into the shut folder", await viaToken((v) => v.save("Ideas/Sealed/twin-new.md", "x\n")), await viaApp(() => app.save("Ideas/Sealed/twin-new-app.md", "x\n"))],
      ["read the read-only folder", await viaToken((v) => v.note("Reference/twin-ref.md")), await viaApp(() => app.note("Reference/twin-ref.md"))],
      ["read where no entry reaches", await viaToken((v) => v.note("Misc/twin-misc.md")), await viaApp(() => app.note("Misc/twin-misc.md"))],
      ["read the shut folder", await viaToken((v) => v.note("Ideas/Sealed/twin-seal.md")), await viaApp(() => app.note("Ideas/Sealed/twin-seal.md"))],
      ["delete in the read-only folder", await viaToken((v) => v.remove("Reference/twin-ref.md")), await viaApp(() => app.remove("Reference/twin-ref.md"))],
      ["move into the read-only folder", await viaToken((v) => v.move("Ideas/twin-new.md", "Reference/twin-moved.md")), await viaApp(() => app.move("Ideas/twin-new-app.md", "Reference/twin-moved-app.md"))],
    ];
    for (const [what, byToken, byApp] of same) expect(byApp, `${what}: the app's status against the token's`).toBe(byToken);
    expect(same.map(([, status]) => status), "the token's own answers, so the comparison is not of two 200s").toEqual([200, 403, 403, 403, 200, 403, 403, 403, 403]);

    expect((await app.list()).notes.map((n: { path: string }) => n.path)).toEqual(listedPaths(await vaultAs(token).list()));
    expect((await app.search("twin-9037")).results).toEqual(bodyOf(await vaultAs(token).search("twin-9037")).results);
    expect((await app.search("twin-9037")).results.map((r: { path: string }) => r.path)).toEqual(["Reference/twin-ref.md"]);
  });

  it("is held to rights that change: the very next call follows the new list", async () => {
    bodyOf(await manage(owner).createIdentity("shifting", "app", [{ path: "Ideas/", access: "write" }]));
    const app = await asApp("shifting");
    expect(await app.save("Ideas/shifting.md", "one\n")).toMatchObject({ result: "saved" });

    bodyOf(await manage(owner).setRights("shifting", []));
    expect((await refusal(() => app.note("Ideas/shifting.md"))).status).toBe(403);
    expect((await refusal(() => app.save("Ideas/shifting.md", "two\n", { base: 1 }))).status).toBe(403);

    bodyOf(await manage(owner).setRights("shifting", [{ path: "Ideas/", access: "read" }]));
    expect(await app.note("Ideas/shifting.md")).toMatchObject({ text: "one\n" });
    expect((await refusal(() => app.save("Ideas/shifting.md", "two\n", { base: 1 }))).status).toBe(403);
  });

  it("holds an identity that does not exist to no rights at all", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/ghost-target.md", "x\n"));
    const refused = await refusal(async () => {
      const ghost = await asApp("ghost-app");
      return ghost.note("Ideas/ghost-target.md");
    });
    expect(refused.status).toBe(403);
    const refusedWrite = await refusal(async () => {
      const ghost = await asApp("ghost-app");
      return ghost.save("Ideas/ghost-new.md", "x\n");
    });
    expect(refusedWrite.status).toBe(403);
    expect((await vaultAs(owner).note("Ideas/ghost-new.md")).status).toBe(404);
  });
});
