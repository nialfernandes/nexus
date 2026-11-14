// Folder rights: each identity may read or write only the folders it holds, every version records the identity that
// wrote it, a read or write outside the rights answers 403 naming the path, and list, search and the changes feed
// show only what the caller may read. Through the Nexus Worker with real tokens (see __fixtures__/identity-world.ts
// for how a token is got, the rights model and the shape of every answer).
//
// The seeded identities come from Nexus's own migrations: `recorder` holds write on Podcasts/Transcripts/, `agents`
// holds write on everything except Private/. Identities made here use the routes only `owner` may call.

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, type Answer } from "./__fixtures__/nexus-world";
import { listedPaths, manage, readWholeFeed, tokenFor, vaultAs, type Who } from "./__fixtures__/identity-world";

let ownerCookie: string;
let owner: Who;
let recorder: Who;
let agents: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  recorder = tokenFor(() => ownerCookie, "recorder", "test recorder");
  agents = tokenFor(() => ownerCookie, "agents", "lab-m");
});

/** A 403 that names the path it turned away. */
function expectForbidden(answer: Answer, path: string, what: string): void {
  expectRefusal(answer, 403, what);
  expect(answer.body.error, `${what}: the refusal names the path`).toContain(path);
}

describe("recorder holds write on Podcasts/Transcripts/ and nothing else", () => {
  it("saves a transcript, and the version's writer reads recorder", async () => {
    expect(bodyOf(await vaultAs(recorder).save("Podcasts/Transcripts/Ep 1.md", "Welcome to episode one.\n"))).toMatchObject({
      result: "saved", path: "Podcasts/Transcripts/Ep 1.md", version: 1,
    });

    expect(bodyOf(await vaultAs(owner).note("Podcasts/Transcripts/Ep 1.md"))).toMatchObject({
      version: 1, text: "Welcome to episode one.\n", writer: "recorder",
    });
    const history = bodyOf(await vaultAs(owner).history("Podcasts/Transcripts/Ep 1.md"));
    expect(history.versions.map((v: { writer: string }) => v.writer)).toEqual(["recorder"]);
  });

  it("answers 403 naming Ideas/a.md for a save outside its folder, and keeps nothing", async () => {
    const answer = await vaultAs(recorder).save("Ideas/a.md", "not for recorder\n");
    expectForbidden(answer, "Ideas/a.md", "a save by recorder to Ideas/a.md");
    expectRefusal(await vaultAs(owner).note("Ideas/a.md"), 404, "the note recorder was turned away from");
  });

  it("stops at the folder's edge: a folder with a similar name, and the folder above it, are not recorder's", async () => {
    expectForbidden(await vaultAs(recorder).save("Podcasts/Transcripts-old/Ep 0.md", "x\n"), "Podcasts/Transcripts-old/Ep 0.md", "a folder that only starts with the same letters");
    expectForbidden(await vaultAs(recorder).save("Podcasts/Notes.md", "x\n"), "Podcasts/Notes.md", "the folder above");
    expectForbidden(await vaultAs(recorder).save("Podcasts/Transcripts.md", "x\n"), "Podcasts/Transcripts.md", "a note named like the folder");
  });

  it("can read, change, move inside the folder and delete what is in it (write includes read)", async () => {
    bodyOf(await vaultAs(recorder).save("Podcasts/Transcripts/Ep 2.md", "two\n"));
    expect(bodyOf(await vaultAs(recorder).note("Podcasts/Transcripts/Ep 2.md"))).toMatchObject({ text: "two\n", writer: "recorder" });
    expect(bodyOf(await vaultAs(recorder).history("Podcasts/Transcripts/Ep 2.md")).versions).toHaveLength(1);
    expect(bodyOf(await vaultAs(recorder).save("Podcasts/Transcripts/Ep 2.md", "two, fixed\n", { base: 1 }))).toMatchObject({ version: 2 });
    expect(bodyOf(await vaultAs(recorder).move("Podcasts/Transcripts/Ep 2.md", "Podcasts/Transcripts/Ep 2b.md"))).toMatchObject({ result: "moved" });
    expect(bodyOf(await vaultAs(recorder).remove("Podcasts/Transcripts/Ep 2b.md"))).toMatchObject({ result: "deleted" });
  });

  it("cannot read, change, move or delete a note outside its folder, whether or not it is there", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/recorder-cannot.md", "private to owner\n"));
    expectForbidden(await vaultAs(recorder).note("Ideas/recorder-cannot.md"), "Ideas/recorder-cannot.md", "a read of a note that exists");
    expectForbidden(await vaultAs(recorder).note("Ideas/never-made.md"), "Ideas/never-made.md", "a read of a note that does not exist");
    expectForbidden(await vaultAs(recorder).history("Ideas/recorder-cannot.md"), "Ideas/recorder-cannot.md", "a history read");
    expectForbidden(await vaultAs(recorder).save("Ideas/recorder-cannot.md", "changed\n", { base: 1 }), "Ideas/recorder-cannot.md", "a change");
    expectForbidden(await vaultAs(recorder).remove("Ideas/recorder-cannot.md"), "Ideas/recorder-cannot.md", "a delete");

    bodyOf(await vaultAs(recorder).save("Podcasts/Transcripts/Ep 3.md", "three\n"));
    expectForbidden(await vaultAs(recorder).move("Podcasts/Transcripts/Ep 3.md", "Ideas/recorder-moved.md"), "Ideas/recorder-moved.md", "a move out of the folder");
    expectForbidden(await vaultAs(recorder).move("Ideas/recorder-cannot.md", "Podcasts/Transcripts/Ep 4.md"), "Ideas/recorder-cannot.md", "a move in from outside");

    expect(bodyOf(await vaultAs(owner).note("Ideas/recorder-cannot.md"))).toMatchObject({ version: 1, text: "private to owner\n" });
    expect(bodyOf(await vaultAs(owner).note("Podcasts/Transcripts/Ep 3.md"))).toMatchObject({ version: 1, text: "three\n" });
  });

  it("lists, searches and sees in the changes feed only what is in its folder", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/recorder-search.md", "ibis-4417 in the ideas folder\n"));
    bodyOf(await vaultAs(recorder).save("Podcasts/Transcripts/Ep 5.md", "ibis-4417 in a transcript\n"));

    const listed = listedPaths(await vaultAs(recorder).list());
    expect(listed).toContain("Podcasts/Transcripts/Ep 5.md");
    expect(listed.filter((p) => !p.startsWith("Podcasts/Transcripts/")), "nothing recorder may not read").toEqual([]);
    expect(listedPaths(await vaultAs(owner).list())).toContain("Ideas/recorder-search.md");
    expect(listedPaths(await vaultAs(recorder).list("Ideas"))).toEqual([]);

    const found = bodyOf(await vaultAs(recorder).search("ibis-4417")).results.map((r: { path: string }) => r.path);
    expect(found).toEqual(["Podcasts/Transcripts/Ep 5.md"]);

    const feed = await readWholeFeed(recorder, 3);
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.filter((c) => !c.path.startsWith("Podcasts/Transcripts/")), "nothing recorder may not read").toEqual([]);
    expect(feed.every((c) => c.writer === "recorder" || c.writer === "owner"), "the feed names who wrote each version").toBe(true);
  });
});

describe("agents hold write on everything except Private/", () => {
  const SECRET = "heron-7731";

  it("saves and reads outside Private/, and the version's writer reads agents", async () => {
    expect(bodyOf(await vaultAs(agents).save("Ideas/by-agents.md", "from the lab\n"))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await vaultAs(owner).note("Ideas/by-agents.md"))).toMatchObject({ writer: "agents", text: "from the lab\n" });
    expect(bodyOf(await vaultAs(agents).note("Ideas/by-agents.md"))).toMatchObject({ writer: "agents" });
    expect(bodyOf(await vaultAs(agents).save("Top level.md", "at the root\n"))).toMatchObject({ result: "saved" });
  });

  it("cannot read, change, move or delete anything under Private/, whether or not it is there", async () => {
    bodyOf(await vaultAs(owner).save("Private/diary.md", `${SECRET} my diary\n`));
    expectForbidden(await vaultAs(agents).note("Private/diary.md"), "Private/diary.md", "a read");
    expectForbidden(await vaultAs(agents).note("Private/none.md"), "Private/none.md", "a read of a note that is not there");
    expectForbidden(await vaultAs(agents).history("Private/diary.md"), "Private/diary.md", "a history read");
    expectForbidden(await vaultAs(agents).save("Private/diary.md", "overwritten\n", { base: 1 }), "Private/diary.md", "a change");
    expectForbidden(await vaultAs(agents).save("Private/new.md", "x\n"), "Private/new.md", "a new note");
    expectForbidden(await vaultAs(agents).remove("Private/diary.md"), "Private/diary.md", "a delete");
    expectForbidden(await vaultAs(agents).move("Private/diary.md", "Ideas/diary.md"), "Private/diary.md", "a move out of Private/");
    expectForbidden(await vaultAs(agents).move("Ideas/by-agents.md", "Private/by-agents.md"), "Private/by-agents.md", "a move into Private/");

    expect(bodyOf(await vaultAs(owner).note("Private/diary.md"))).toMatchObject({ version: 1, text: `${SECRET} my diary\n` });
    expect(bodyOf(await vaultAs(owner).note("Ideas/by-agents.md"))).toMatchObject({ version: 1 });
  });

  it("does not list anything under Private/, and lists a folder called Private as empty", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/agents-list.md", "listed\n"));
    const listed = listedPaths(await vaultAs(agents).list());
    expect(listed).toContain("Ideas/agents-list.md");
    expect(listed.filter((p) => p.startsWith("Private/")), "Private/ notes in the list").toEqual([]);
    expect(listedPaths(await vaultAs(agents).list("Private"))).toEqual([]);
    expect(listedPaths(await vaultAs(owner).list("Private"))).toContain("Private/diary.md");
  });

  it("leaves Private/ notes out of search, though the same words in another folder are found", async () => {
    bodyOf(await vaultAs(owner).save("Ideas/agents-public.md", `${SECRET} in a note agents may read\n`));
    const asAgents = bodyOf(await vaultAs(agents).search(SECRET)).results.map((r: { path: string }) => r.path);
    expect(asAgents).toEqual(["Ideas/agents-public.md"]);
    const asOwner = bodyOf(await vaultAs(owner).search(SECRET)).results.map((r: { path: string }) => r.path);
    expect(asOwner).toEqual(["Ideas/agents-public.md", "Private/diary.md"]);
  });

  it("leaves Private/ versions out of the changes feed, and the feed carries on past them", async () => {
    const TEXT = "kestrel-private-body";
    // Five Private/ versions, then a note agents may read: a small page can hold nothing but Private/ versions.
    for (let i = 1; i <= 5; i++) bodyOf(await vaultAs(owner).save(`Private/run-${i}.md`, `${TEXT} ${i}\n`));
    bodyOf(await vaultAs(owner).save("Ideas/after-the-private-run.md", "visible\n"));

    const asAgents = await readWholeFeed(agents, 2);
    expect(asAgents.filter((c) => c.path.startsWith("Private/")), "Private/ versions in the agents' feed").toEqual([]);
    expect(asAgents.map((c) => c.path), "a change after the hidden ones").toContain("Ideas/after-the-private-run.md");
    expect(asAgents.map((c) => c.path)).toContain("Ideas/by-agents.md");
    expect(JSON.stringify(asAgents), "the text of a Private/ note in the feed").not.toContain(TEXT);

    const asOwner = await readWholeFeed(owner, 2);
    expect(asOwner.filter((c) => c.path.startsWith("Private/")).length).toBeGreaterThanOrEqual(6);
  });
});

describe("rights an identity is given, read from the folder prefixes", () => {
  it("lets a read-only folder be read and not written, and a path no entry reaches be neither", async () => {
    bodyOf(await manage(owner).createIdentity("reader", "agent", [
      { path: "Reference/", access: "read" },
      { path: "Ideas/", access: "write" },
    ]));
    const reader: Who = tokenFor(() => ownerCookie, "reader", "reader device");

    bodyOf(await vaultAs(owner).save("Reference/book.md", "a reference\n"));
    expect(bodyOf(await vaultAs(reader).note("Reference/book.md"))).toMatchObject({ text: "a reference\n", writer: "owner" });
    expect(listedPaths(await vaultAs(reader).list())).toContain("Reference/book.md");
    expectForbidden(await vaultAs(reader).save("Reference/book.md", "changed\n", { base: 1 }), "Reference/book.md", "a write to a read-only folder");
    expectForbidden(await vaultAs(reader).remove("Reference/book.md"), "Reference/book.md", "a delete in a read-only folder");

    expect(bodyOf(await vaultAs(reader).save("Ideas/reader.md", "mine\n"))).toMatchObject({ result: "saved" });
    expectForbidden(await vaultAs(reader).note("Misc/elsewhere.md"), "Misc/elsewhere.md", "a read of a folder no entry reaches");
    expectForbidden(await vaultAs(reader).save("Misc/elsewhere.md", "x\n"), "Misc/elsewhere.md", "a write to a folder no entry reaches");
  });

  it("lets the longest prefix decide, so a folder inside a writable one can be narrowed or shut", async () => {
    bodyOf(await manage(owner).createIdentity("narrowed", "agent", [
      { path: "", access: "write" },
      { path: "Ideas/", access: "write" },
      { path: "Ideas/Locked/", access: "read" },
      { path: "Ideas/Sealed/", access: "none" },
    ]));
    const narrowed: Who = tokenFor(() => ownerCookie, "narrowed", "narrowed device");

    bodyOf(await vaultAs(owner).save("Ideas/Locked/lock.md", "locked\n"));
    bodyOf(await vaultAs(owner).save("Ideas/Sealed/seal.md", "sealed\n"));
    expect(bodyOf(await vaultAs(narrowed).save("Ideas/free.md", "free\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(narrowed).save("Whole vault.md", "the empty prefix reaches everything\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(narrowed).note("Ideas/Locked/lock.md"))).toMatchObject({ text: "locked\n" });
    expectForbidden(await vaultAs(narrowed).save("Ideas/Locked/new.md", "x\n"), "Ideas/Locked/new.md", "a write where a nearer entry says read");
    expectForbidden(await vaultAs(narrowed).note("Ideas/Sealed/seal.md"), "Ideas/Sealed/seal.md", "a read where a nearer entry says none");

    const listed = listedPaths(await vaultAs(narrowed).list());
    expect(listed).toContain("Ideas/Locked/lock.md");
    expect(listed).not.toContain("Ideas/Sealed/seal.md");
  });
});

describe("the owner is never held to a folder", () => {
  it("writes and reads everywhere, Private/ included, with the owner's sign-in or a token made for owner, and the writer reads owner", async () => {
    const laptop = tokenFor(() => ownerCookie, "owner", "the owner's laptop");
    for (const [who, name] of [[owner, "sign-in"], [laptop, "token"]] as const) {
      expect(bodyOf(await vaultAs(who).save(`Private/owner-own-${name}.md`, "mine\n")), name).toMatchObject({ result: "saved" });
      expect(bodyOf(await vaultAs(who).note(`Private/owner-own-${name}.md`)), name).toMatchObject({ writer: "owner" });
      expect(bodyOf(await vaultAs(who).save(`Podcasts/Transcripts/by-owner-${name}.md`, "mine\n")), name).toMatchObject({ result: "saved" });
      expect(listedPaths(await vaultAs(who).list()), name).toContain(`Private/owner-own-${name}.md`);
    }
  });
});
