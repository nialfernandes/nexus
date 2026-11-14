// The changes feed: every version after a cursor, oldest first, with a next cursor, so a sync client and the
// agents can catch up without missing a change or taking one twice. A delete is a version, so it is in it too, and a
// refused save is not a version, so it is not. Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts
// for the routes and the shape of every answer).
//
// This file has a database of its own (each test file does), and the first test is the only one that writes before
// the others read, so the feed starts empty and every version in it is one this file made.

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, GARDEN_V2, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { bodyOf, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

interface Change {
  id: string;
  version: number;
  kind: string;
  kid: number;
  writer: string;
  hash: string;
  blob?: string;
}

/** What the feed should say about each version made, in the order it was made. */
interface Expected { id: string; version: number; kind: string; blob?: string }

const made: Expected[] = [];

beforeAll(async () => {
  await setUpNexus();
  owner = vault((await signInOwner()).cookie);
});

/** Every page of the feed, `size` changes at a time, from the start until a page comes back empty. */
async function readAllInPages(size: number): Promise<{ pages: Change[][]; cursors: Array<string | number> }> {
  const pages: Change[][] = [];
  const cursors: Array<string | number> = [];
  let after: string | number | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = bodyOf(await owner.changes(after, size));
    expect(Array.isArray(page.changes)).toBe(true);
    expect(page.next, "every page names the cursor to carry on from").not.toBeUndefined();
    expect(page.next).not.toBeNull();
    pages.push(page.changes);
    cursors.push(page.next);
    if (page.changes.length === 0) return { pages, cursors };
    after = page.next;
  }
  throw new Error("the feed never ran out");
}

/** The blobs the saves below take turns with, so the feed has different bytes to give back. */
const BLOBS = [GARDEN_V1.blob, GARDEN_V2.blob, PODCAST_V1.blob];
const blobFor = (n: number): string => BLOBS[n % BLOBS.length];

describe("the changes feed", () => {
  it("returns 25 versions exactly once each, in order, read in pages of 10", async () => {
    const A = GARDEN_V1.id;
    const B = "feed-b";
    const D = PODCAST_V1.id;

    // 1 and 2: a note saved, then saved again.
    expect(bodyOf(await owner.save(GARDEN_V1, 0))).toMatchObject({ result: "saved", id: A, version: 1 });
    made.push({ id: A, version: 1, kind: "save", blob: GARDEN_V1.blob });
    expect(bodyOf(await owner.save(GARDEN_V2, 1))).toMatchObject({ result: "saved", version: 2 });
    made.push({ id: A, version: 2, kind: "save", blob: GARDEN_V2.blob });

    // A save that started from an old version is refused, and is not a version: nothing of it reaches the feed.
    expect((await owner.save({ id: A, blob: PODCAST_V1.blob }, 1)).status).toBe(409);

    // 3 to 5: two more notes, one of them deleted.
    expect(bodyOf(await owner.save({ id: B, blob: blobFor(0) }, 0)).version).toBe(1);
    made.push({ id: B, version: 1, kind: "save", blob: blobFor(0) });
    expect(bodyOf(await owner.save(PODCAST_V1, 0)).version).toBe(1);
    made.push({ id: D, version: 1, kind: "save", blob: PODCAST_V1.blob });
    expect(bodyOf(await owner.remove(D, 1))).toMatchObject({ result: "deleted", version: 2 });
    made.push({ id: D, version: 2, kind: "delete" });

    // 6: the deleted note brought back by a save that starts from the delete.
    expect(bodyOf(await owner.save(PODCAST_V1, 2))).toMatchObject({ result: "saved", version: 3 });
    made.push({ id: D, version: 3, kind: "save", blob: PODCAST_V1.blob });

    // 7 to 22: sixteen more saves of one note.
    for (let n = 2; n <= 17; n++) {
      expect(bodyOf(await owner.save({ id: B, blob: blobFor(n) }, n - 1))).toMatchObject({ result: "saved", version: n });
      made.push({ id: B, version: n, kind: "save", blob: blobFor(n) });
    }

    // 23 to 25: three more of the first note.
    for (let n = 3; n <= 5; n++) {
      expect(bodyOf(await owner.save({ id: A, blob: blobFor(n) }, n - 1))).toMatchObject({ result: "saved", version: n });
      made.push({ id: A, version: n, kind: "save", blob: blobFor(n) });
    }
    expect(made).toHaveLength(25);

    const { pages, cursors } = await readAllInPages(10);

    // 10, 10, 5 and then nothing: no version missed at a page's edge, none repeated.
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5, 0]);

    const all = pages.flat();
    expect(all.map((c) => [c.id, c.version])).toEqual(made.map((m) => [m.id, m.version]));
    expect(new Set(all.map((c) => `${c.id}#${c.version}`)).size).toBe(25);

    // Each one says what kind of version it is, every save carries its blob exactly as it was sent, and a delete has none.
    for (const [i, change] of all.entries()) {
      const want = made[i];
      expect(change, `${want.id} version ${want.version}`).toMatchObject({ id: want.id, version: want.version, kind: want.kind, kid: 1, writer: "owner" });
      expect(change.hash, `${want.id} version ${want.version}`).toMatch(/^[0-9a-f]{64}$/);
      if (want.blob === undefined) expect(change, "a delete carries no blob").not.toHaveProperty("blob");
      else expect(change.blob, `${want.id} version ${want.version}`).toBe(want.blob);
    }

    // A cursor is a place in the feed: the last one is the end of it, so asking from there gives nothing new.
    expect(bodyOf(await owner.changes(cursors[cursors.length - 1], 10)).changes).toEqual([]);
  });

  it("starts at the beginning when no cursor is given, and a different page size cuts the same feed", async () => {
    const whole: Change[] = bodyOf(await owner.changes(undefined, 100)).changes;
    expect(whole).toHaveLength(25);
    const { pages } = await readAllInPages(7);
    expect(pages.map((p) => p.length)).toEqual([7, 7, 7, 4, 0]);
    expect(pages.flat().map((c) => [c.id, c.version])).toEqual(whole.map((c) => [c.id, c.version]));
  });

  it("carries on from the end: a save made later arrives once, and nothing is taken twice", async () => {
    const { cursors } = await readAllInPages(10);
    const end = cursors[cursors.length - 1];

    bodyOf(await owner.save({ id: "feed-late", blob: GARDEN_V1.blob }, 0));
    const first = bodyOf(await owner.changes(end, 10));
    expect(first.changes.map((c: Change) => [c.id, c.version])).toEqual([["feed-late", 1]]);

    expect(bodyOf(await owner.changes(first.next, 10)).changes).toEqual([]);
  });
});
