// The changes feed is capped by the size of what it sends as well as by the number of versions. A version carries its
// whole encrypted blob (up to 1,000,000 bytes, 1,333,336 characters of base64), and a page of 500 of them would be
// hundreds of megabytes on a phone. A page ends before the version that would take it past the cap, so no version is
// ever split, the cursor is the place of the last version sent so the next page starts exactly after it, and one
// version larger than the cap is sent alone, because a page has to move the cursor on or a device would never finish.
//
// What is counted is the blob as it is sent, as base64 text; a delete version is sent without a blob and counts for none.
// The cap is the setting NEXUS_CHANGES_PAGE_BYTES (settings.test.ts); the default is 4,000,000.
//
// The notes are made through the real save route. A blob here is bytes of the size a test asks for, with the header an
// encrypted note begins with (docs/FORMAT.md section 6) and the rest filled in: the server never reads past the header.
// This file has a database of its own, as each test file does.

import { beforeAll, describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES } from "./fields";
import { DEFAULT_CHANGES_PAGE_BYTES } from "./store";
import type { NexusEnv } from "./plugs/cloudflare/host";
import { bodyOf, nexusEnv, signInOwner } from "./__fixtures__/nexus-world";
import { vaultAs, type Who } from "./__fixtures__/identity-world";

let owner: Who;

beforeAll(async () => {
  owner = { cookie: (await signInOwner()).cookie };
});

interface Change { id: string; version: number; kind: string; blob?: string }

/** An encrypted note's blob of `size` bytes as base64: the format's header (version 1, key number 1), then filler that differs with `seed`. */
function blobOf(size: number, seed: number): string {
  const bytes = new Uint8Array(size);
  bytes.set([1, 0, 0, 0, 1]);
  for (let i = 5; i < size; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
  return Buffer.from(bytes).toString("base64");
}

/** A world of its own: a fresh database, with the page cap set as `cap` says (left alone when it is undefined). */
async function world(cap?: number) {
  const env: NexusEnv = await nexusEnv(cap === undefined ? {} : { NEXUS_CHANGES_PAGE_BYTES: String(cap) });
  return { feed: vaultAs(owner, env) };
}

/** Saves one new note per size, in order, under ids `${prefix}-0`, `${prefix}-1`, and so on. */
async function saveNotes(feed: ReturnType<typeof vaultAs>, prefix: string, sizes: number[]): Promise<string[]> {
  const blobs: string[] = [];
  for (const [n, size] of sizes.entries()) {
    const blob = blobOf(size, n);
    bodyOf(await feed.save({ id: `${prefix}-${n}`, blob }, 0));
    blobs.push(blob);
  }
  return blobs;
}

/** Every page of the feed, from the start, following the cursor until it stops moving. */
async function readPages(feed: ReturnType<typeof vaultAs>, limit?: number): Promise<{ pages: Change[][]; cursors: string[] }> {
  const pages: Change[][] = [];
  const cursors: string[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const answer = bodyOf(await feed.changes(after, limit));
    expect(typeof answer.next, "every page names the cursor to carry on from").toBe("string");
    if (answer.changes.length === 0) return { pages, cursors };
    pages.push(answer.changes);
    cursors.push(answer.next);
    after = answer.next;
  }
  throw new Error("the feed never ran out");
}

const sent = (page: Change[]): number => page.reduce((total, change) => total + (change.blob?.length ?? 0), 0);

/** Every version exactly once and in order, and the pages cut so that none is split: what every read of the feed has to give. */
function expectWhole(pages: Change[][], ids: string[], blobs: string[]): void {
  const all = pages.flat();
  expect(all.map((c) => c.id), "every version once, in the order it was made").toEqual(ids);
  expect(all.map((c) => c.blob), "every blob as it was sent").toEqual(blobs);
  expect(pages.every((page) => page.length > 0), "no empty page before the end").toBe(true);
}

describe("a feed of 30 versions of 1 MB each, capped at 4 MB", () => {
  it("answers in pages of at most 4, every version once, the cursor carrying on from where each page stopped (blobs of 1,000,000 characters)", async () => {
    // 750,000 bytes is 1,000,000 characters of base64: four of them are exactly the cap.
    const { feed } = await world(4_000_000);
    const blobs = await saveNotes(feed, "fit", Array(30).fill(750_000));
    const ids = blobs.map((_, n) => `fit-${n}`);

    const { pages, cursors } = await readPages(feed);
    expect(pages.map((p) => p.length)).toEqual([4, 4, 4, 4, 4, 4, 4, 2]);
    for (const page of pages) expect(sent(page)).toBeLessThanOrEqual(4_000_000);
    expectWhole(pages, ids, blobs);

    // The cursor is exact: asking from the end of any page gives the next page's versions and nothing of this one.
    const second = bodyOf(await feed.changes(cursors[0]));
    expect(second.changes.map((c: Change) => c.id)).toEqual(pages[1].map((c) => c.id));
    expect(second.next).toBe(cursors[1]);
  });

  it("answers in pages of at most 3 when the blobs are the largest a note may be (1,000,000 bytes, 1,333,336 characters)", async () => {
    const { feed } = await world(4_000_000);
    const blobs = await saveNotes(feed, "big", Array(30).fill(MAX_BLOB_BYTES));
    const ids = blobs.map((_, n) => `big-${n}`);

    const { pages } = await readPages(feed);
    expect(pages.map((p) => p.length)).toEqual(Array(10).fill(3));
    for (const page of pages) expect(sent(page)).toBeLessThanOrEqual(4_000_000);
    expectWhole(pages, ids, blobs);
  });
});

describe("the cap", () => {
  it("is 4,000,000 bytes when nothing sets it", async () => {
    expect(DEFAULT_CHANGES_PAGE_BYTES).toBe(4_000_000);
    const { feed } = await world();
    const blobs = await saveNotes(feed, "default", Array(9).fill(750_000));
    const { pages } = await readPages(feed);
    expect(pages.map((p) => p.length), "four at 1,000,000 characters fill the default cap").toEqual([4, 4, 1]);
    expectWhole(pages, blobs.map((_, n) => `default-${n}`), blobs);
  });

  it("sends one version that is larger than the cap alone, and carries on after it", async () => {
    // 600,000 bytes is 800,000 characters, over a cap of 500,000.
    const { feed } = await world(500_000);
    const blobs = await saveNotes(feed, "alone", [600_000, 600_000, 600_000]);
    const { pages } = await readPages(feed);
    expect(pages.map((p) => p.length)).toEqual([1, 1, 1]);
    expectWhole(pages, blobs.map((_, n) => `alone-${n}`), blobs);
  });

  it("never splits a version: a small one after a big one starts the next page, and small ones share a page", async () => {
    // Characters of base64: 300,000 / 1,000,000 / 100,000 / 100,000 / 400,000 / 100,000, with a cap of 1,000,000.
    const { feed } = await world(1_000_000);
    const blobs = await saveNotes(feed, "mix", [225_000, 750_000, 75_000, 75_000, 300_000, 75_000]);
    const { pages } = await readPages(feed);
    expect(pages.map((p) => p.map((c) => c.id))).toEqual([
      ["mix-0"],
      ["mix-1"],
      ["mix-2", "mix-3", "mix-4", "mix-5"],
    ]);
    expectWhole(pages, blobs.map((_, n) => `mix-${n}`), blobs);
  });

  it("counts a delete version as no blob, so deletes ride on a page that is already full", async () => {
    const { feed } = await world(1_000_000);
    const blobs = await saveNotes(feed, "gone", [750_000, 750_000, 750_000]);
    for (let n = 0; n < 3; n++) bodyOf(await feed.remove(`gone-${n}`, 1));
    const { pages } = await readPages(feed);
    // Each save is a whole cap by itself; the three deletes send no blob, so they follow the last save on its page.
    expect(pages.map((p) => p.map((c) => `${c.id}:${c.kind}`))).toEqual([
      ["gone-0:save"],
      ["gone-1:save"],
      ["gone-2:save", "gone-0:delete", "gone-1:delete", "gone-2:delete"],
    ]);
    expect(pages.flat().filter((c) => c.kind === "save").map((c) => c.blob)).toEqual(blobs);
    expect(pages.flat().filter((c) => c.kind === "delete").every((c) => !("blob" in c))).toBe(true);
  });

  it("works with the count limit: a limit under what the cap would let through still ends the page", async () => {
    const { feed } = await world(4_000_000);
    const blobs = await saveNotes(feed, "few", Array(7).fill(7_500));
    const { pages } = await readPages(feed, 3);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expectWhole(pages, blobs.map((_, n) => `few-${n}`), blobs);
  });

  it("gives the cursor it was given when there is nothing new, and a cursor at the very end stays there", async () => {
    const { feed } = await world(1_000_000);
    await saveNotes(feed, "end", [750_000, 750_000]);
    const { cursors } = await readPages(feed);
    const end = cursors[cursors.length - 1];
    expect(bodyOf(await feed.changes(end))).toEqual({ changes: [], next: end });
  });
});
