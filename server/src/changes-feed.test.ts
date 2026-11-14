// The changes feed: every version after a cursor, oldest first, with a next cursor, so a sync client and the
// agents can catch up without missing a change or taking one twice. Merged, clash, move and delete versions are
// versions, so they are in it too. Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes
// and the shape of every answer).
//
// This file has a database of its own (each test file does), and the first test is the only one that writes before
// the others read, so the feed starts empty and every version in it is one this file made.

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

interface Change {
  path: string;
  version: number;
  kind: string;
  writer: string;
  merged: boolean;
  clash: boolean;
  text: string;
  from?: string;
}

/** What the feed should say about each version made, in the order it was made. */
interface Expected { path: string; version: number; kind: string; merged: boolean; clash: boolean; text?: string; from?: string }

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

describe("the changes feed", () => {
  it("returns 25 versions exactly once each, in order, read in pages of 10", async () => {
    const A = "Feed/a.md";
    const MOVED = "Feed/moved.md";
    const B = "Feed/b.md";
    const D = "Feed/d.md";

    // 1 to 3: a note saved, then saved again, then a merged save.
    expect(bodyOf(await owner.save(A, "one\ntwo\nthree\n"))).toMatchObject({ result: "saved", version: 1 });
    made.push({ path: A, version: 1, kind: "save", merged: false, clash: false, text: "one\ntwo\nthree\n" });
    expect(bodyOf(await owner.save(A, "ONE\ntwo\nthree\n", { base: 1 }))).toMatchObject({ result: "saved", version: 2 });
    made.push({ path: A, version: 2, kind: "save", merged: false, clash: false, text: "ONE\ntwo\nthree\n" });
    expect(bodyOf(await owner.save(A, "one\ntwo\nTHREE\n", { base: 1 }))).toMatchObject({ result: "merged", version: 3 });
    made.push({ path: A, version: 3, kind: "save", merged: true, clash: false, text: "ONE\ntwo\nTHREE\n" });

    // 4: a clash version, which is a version of the note like any other.
    const clash = bodyOf(await owner.save(A, "uno\ntwo\nthree\n", { base: 1 }), 409);
    expect(clash.result).toBe("clash");
    expect(clash.incoming.version).toBe(4);
    made.push({ path: A, version: 4, kind: "save", merged: false, clash: true, text: "uno\ntwo\nthree\n" });

    // 5 to 7: two more notes, one of them deleted.
    expect(bodyOf(await owner.save(B, "b1\n")).version).toBe(1);
    made.push({ path: B, version: 1, kind: "save", merged: false, clash: false, text: "b1\n" });
    expect(bodyOf(await owner.save(D, "d1\n")).version).toBe(1);
    made.push({ path: D, version: 1, kind: "save", merged: false, clash: false, text: "d1\n" });
    expect(bodyOf(await owner.remove(D))).toMatchObject({ result: "deleted", version: 2 });
    made.push({ path: D, version: 2, kind: "delete", merged: false, clash: false });

    // 8: the clash resolved, 9: the note moved.
    const resolved = await owner.save(A, "ONE\ntwo\nTHREE\nresolved\n", { base: 3, resolves: 4 });
    expect(bodyOf(resolved)).toMatchObject({ result: "saved", version: 5 });
    made.push({ path: A, version: 5, kind: "save", merged: false, clash: false, text: "ONE\ntwo\nTHREE\nresolved\n" });
    expect(bodyOf(await owner.move(A, MOVED))).toMatchObject({ result: "moved", path: MOVED, version: 6 });
    made.push({ path: MOVED, version: 6, kind: "move", merged: false, clash: false, from: A });

    // 10 to 25: sixteen more saves of one note.
    for (let n = 2; n <= 17; n++) {
      const text = `b${n}\n`;
      expect(bodyOf(await owner.save(B, text, { base: n - 1 }))).toMatchObject({ result: "saved", version: n });
      made.push({ path: B, version: n, kind: "save", merged: false, clash: false, text });
    }
    expect(made).toHaveLength(25);

    const { pages, cursors } = await readAllInPages(10);

    // 10, 10, 5 and then nothing: no version missed at a page's edge, none repeated.
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5, 0]);

    const all = pages.flat();
    expect(all.map((c) => [c.path, c.version])).toEqual(made.map((m) => [m.path, m.version]));
    expect(new Set(all.map((c) => `${c.path}#${c.version}`)).size).toBe(25);

    // Each one says what kind of version it is, and every save carries its whole text.
    for (const [i, change] of all.entries()) {
      const want = made[i];
      expect(change, `${want.path} version ${want.version}`).toMatchObject({
        path: want.path, version: want.version, kind: want.kind, merged: want.merged, clash: want.clash, writer: "owner",
      });
      if (want.text !== undefined) expect(change.text, `${want.path} version ${want.version}`).toBe(want.text);
      if (want.from !== undefined) expect(change.from).toBe(want.from);
    }

    // A cursor is a place in the feed: the last one is the end of it, so asking from there gives nothing new.
    expect(bodyOf(await owner.changes(cursors[cursors.length - 1], 10)).changes).toEqual([]);
  });

  it("starts at the beginning when no cursor is given, and a different page size cuts the same feed", async () => {
    const whole: Change[] = bodyOf(await owner.changes(undefined, 100)).changes;
    expect(whole).toHaveLength(25);
    const { pages } = await readAllInPages(7);
    expect(pages.map((p) => p.length)).toEqual([7, 7, 7, 4, 0]);
    expect(pages.flat().map((c) => [c.path, c.version])).toEqual(whole.map((c) => [c.path, c.version]));
  });

  it("carries on from the end: a save made later arrives once, and nothing is taken twice", async () => {
    const { cursors } = await readAllInPages(10);
    const end = cursors[cursors.length - 1];

    bodyOf(await owner.save("Feed/late.md", "late\n"));
    const first = bodyOf(await owner.changes(end, 10));
    expect(first.changes.map((c: Change) => [c.path, c.version])).toEqual([["Feed/late.md", 1]]);

    expect(bodyOf(await owner.changes(first.next, 10)).changes).toEqual([]);
  });
});
