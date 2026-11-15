// Opening a vault: the newest version of each note, a page at a time, keeping each note's id, version and path and nothing else. The
// result is the same as reading every version of every note and keeping the newest, which is how `open` used to learn the vault, and
// the notes' texts are read again when a call needs one. Every call goes to the server's own routes (world.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { blobFor, openBlob } from "../../../plugin/tests/world";
import { generateVaultKey } from "@nexus/crypto";
import { AgentVault } from "../src/index";
import { isSafeNotePath } from "../src/paths";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type Seen, type World } from "./world";
import type { FetchLike } from "../src/nexus";

let world: World;
let credentials: AgentCredentials;

beforeEach(async () => {
  world = await openWorld();
  await setUpVault(world);
  credentials = await agentCredentials(world);
});

const open = (options: Parameters<typeof fetchOverNexus>[0] = {}, through?: (real: FetchLike) => FetchLike) => {
  const { fetch, seen } = fetchOverNexus(options);
  return AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch: through ? through(fetch) : fetch }).then((vault) => ({ vault, seen }));
};

const routesOf = (seen: Seen[]) => seen.map((s) => s.route.split("?")[0]);

interface Row { path: string; id: string; version: number }

/**
 * What the vault should say it holds, worked out the long way: every version of every note from the changes feed, the newest of each kept,
 * opened with the world's key. A deleted note, a note the key does not open and a path the plugin would refuse are not notes; of two notes at
 * one path the one saved last wins, then the larger id.
 */
async function worked(): Promise<{ notes: Row[]; unreadable: string[] }> {
  const newest = new Map<string, { version: number; kind: string; at: number; blob?: string }>();
  let after: string | undefined;
  for (;;) {
    const page = (await world.owner.changes(after, 500)).body;
    if (page.changes.length === 0) break;
    for (const change of page.changes) if ((newest.get(change.id)?.version ?? 0) < change.version) newest.set(change.id, change);
    after = page.next;
  }
  const byPath = new Map<string, Row & { at: number }>();
  const unreadable: string[] = [];
  for (const [id, change] of newest) {
    if (change.kind === "delete") continue;
    const note = await openBlob(world.keys, id, change.blob!).catch(() => null);
    if (note === null || !isSafeNotePath(note.path)) {
      unreadable.push(id);
      continue;
    }
    const other = byPath.get(note.path);
    if (other === undefined || change.at > other.at || (change.at === other.at && id > other.id)) byPath.set(note.path, { path: note.path, id, version: change.version, at: change.at });
  }
  return { notes: [...byPath.values()].map(({ path, id, version }) => ({ path, id, version })).sort((a, b) => (a.path < b.path ? -1 : 1)), unreadable: unreadable.sort() };
}

/** A vault with every kind of note in it: saved many times, deleted, brought back, unreadable (another key; a path the plugin refuses) and two at one path. */
async function aVaultOfEveryKind(): Promise<void> {
  const a = await world.elsewhere.create("Daily/a.md", "a1\n");
  await world.elsewhere.update(a.id, "Daily/a.md", "a2\n");
  await world.elsewhere.update(a.id, "Daily/a-renamed.md", "a3\n");
  const b = await world.elsewhere.create("Daily/b.md", "b1\n");
  await world.elsewhere.update(b.id, "Daily/b.md", "b2\n");
  await world.elsewhere.remove(b.id);
  const c = await world.elsewhere.create("Projects/c.md", "c1\n");
  await world.elsewhere.remove(c.id);
  await world.elsewhere.create("Projects/c.md", "c again\n"); // a new note at the deleted one's path
  await world.elsewhere.create("Projects/same.md", "one of two at a path\n");
  await world.elsewhere.create("Projects/same.md", "the other of two at a path\n");
  await world.elsewhere.create("../outside.md", "a path the plugin refuses\n");
  const foreign = { vaultKey: await generateVaultKey(), vaultId: world.keys.vaultId, kid: world.keys.kid };
  bodyOk(await world.agents.save("foreign-key-note", await blobFor(foreign, "foreign-key-note", "Daily/foreign.md", "sealed with another key\n"), { base: 0, kid: foreign.kid }));
  for (let n = 0; n < 7; n++) await world.elsewhere.create(`Many/${n}.md`, `note ${n}\n`);
}

const bodyOk = (answer: { status: number; text: string }) => expect(answer.status, answer.text.slice(0, 100)).toBe(200);

describe("opening a vault", () => {
  it("learns what the long way learns: the same paths, ids and versions, and the same notes it cannot open", async () => {
    await aVaultOfEveryKind();
    const expected = await worked();
    expect(expected.notes, "a vault worth asking about: one of every kind of note, and the seven others").toHaveLength(10);
    expect(expected.unreadable).toHaveLength(2);

    const { vault } = await open();
    expect(await vault.listNotes()).toEqual(expected.notes);
    expect(await vault.list()).toEqual(expected.notes.map((n) => n.path));
    expect(vault.unreadableNotes()).toEqual(expected.unreadable);
    vault.close();
  });

  it("asks for the newest version of each note, not the changes, and for the changes only after that", async () => {
    await aVaultOfEveryKind();
    const { vault, seen } = await open();
    expect(routesOf(seen)).toEqual(["wraps", "heads", "heads"]);
    expect(seen[1]!.route).toBe("heads?limit=100");
    await vault.list();
    expect(routesOf(seen).slice(3)).toEqual(["changes"]);
    expect(seen[3]!.route, "from the place the heads ended at").toMatch(/^changes\?after=\d+&limit=100$/);
    vault.close();
  });

  it("reads a vault of more than a page in pages of 100, and one more to see the end", async () => {
    for (let n = 0; n < 1100; n++) await world.elsewhere.create(`Bulk/${String(n).padStart(4, "0")}.md`, `note ${n}\n`);
    const { vault, seen } = await open();
    expect(routesOf(seen)).toEqual(["wraps", ...Array(12).fill("heads")]);
    expect((await vault.list()).length).toBe(1100);
    expect(await vault.listNotes()).toEqual((await worked()).notes);
    vault.close();
  });

  it("keeps no text: listing reads no note, and a read of a note's text reads that one note", async () => {
    await aVaultOfEveryKind();
    const { vault, seen } = await open();
    const before = seen.length;
    const paths = await vault.list();
    expect(seen.slice(before).filter((s) => s.route.startsWith("note")), "listing asked for no text").toEqual([]);

    const mark = seen.length;
    expect(await vault.read("Daily/a-renamed.md")).toBe("a3\n");
    const reads = seen.slice(mark).filter((s) => s.route.startsWith("note"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.route).toMatch(/^note\?id=[A-Za-z0-9_-]+&version=3$/);
    expect(paths).toContain("Daily/a-renamed.md");
    vault.close();
  });

  it("does not save a text a note already has, and reads only that one note to know it", async () => {
    await world.elsewhere.create("Daily/a.md", "same text\n");
    for (let n = 0; n < 5; n++) await world.elsewhere.create(`Other/${n}.md`, `other ${n}\n`);
    const { vault, seen } = await open();
    const mark = seen.length;
    expect(await vault.write("Daily/a.md", "same text\n")).toMatchObject({ saved: false, version: 1 });
    expect(seen.slice(mark).map((s) => `${s.method} ${s.route.split("?")[0]}`)).toEqual(["GET changes", "GET note"]);
    vault.close();
  });

  it("is not thrown by a note saved again while its pages are being read: that note is met again at its new version, and the changes go on from the right place", async () => {
    const first = await world.elsewhere.create("Bulk/0000.md", "first\n");
    for (let n = 1; n < 700; n++) await world.elsewhere.create(`Bulk/${String(n).padStart(4, "0")}.md`, `note ${n}\n`);
    let pages = 0;
    const { vault, seen } = await open({
      before: async (call) => {
        // Between the first page of the heads and the second, a plugin edits the note the first page held.
        if (call.route.startsWith("heads") && ++pages === 2) await world.elsewhere.update(first.id, "Bulk/0000.md", "first, edited\n");
      },
    });
    const notes = await vault.listNotes();
    expect(notes).toHaveLength(700);
    expect(notes.find((n) => n.id === first.id)).toEqual({ path: "Bulk/0000.md", id: first.id, version: 2 });
    expect(await vault.read("Bulk/0000.md")).toBe("first, edited\n");
    const mark = seen.length;
    expect(await vault.list()).toHaveLength(700);
    const later = seen.slice(mark).filter((s) => s.route.startsWith("changes"));
    expect(later, "one look at the changes since").toHaveLength(1);
    expect(await vault.listNotes(), "and it took nothing twice").toEqual(notes);
    vault.close();
  });

  it("reads the changes feed when the server has no heads route, and learns the same", async () => {
    await aVaultOfEveryKind();
    const expected = await worked();
    const olderServer = (real: FetchLike): FetchLike => async (url, init) =>
      /\/heads(\?|$)/.test(url) ? { status: 404, text: async () => JSON.stringify({ error: "Nexus has no such route." }) } : real(url, init);
    const { vault, seen } = await open({}, olderServer);
    expect(routesOf(seen)).toEqual(["wraps", "changes", "changes"]);
    expect(await vault.listNotes()).toEqual(expected.notes);
    expect(vault.unreadableNotes()).toEqual(expected.unreadable);
    vault.close();
  });
});
