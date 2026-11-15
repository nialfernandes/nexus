// The heads listing: the newest version of every note, for a client that wants to know what the vault holds now and not the
// versions that were replaced. It pages as the changes feed does (the same limit, the same cap on the blobs of a page, the same
// cursor rules), and its last cursor is a place the changes feed can carry on from.
//
// The notes are made through the real save and delete routes. A blob here is bytes of the size a test asks for, with the header an
// encrypted note begins with (docs/FORMAT.md section 6): the server never reads past the header. This file's worlds are fresh
// databases of their own, as the changes tests' are.

import { describe, expect, it } from "vitest";
import { GARDEN_V1, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { vaultAs, type Who } from "./__fixtures__/identity-world";
import { API, bodyOf, expectRefusal, nexusEnv, send, signInOwner } from "./__fixtures__/nexus-world";
import type { NexusEnv } from "./plugs/cloudflare/host";

interface Head { id: string; version: number; kind: string; kid: number; at: number; hash: string; blob?: string }
type Feed = ReturnType<typeof vaultAs>;

/** An encrypted note's blob of `size` bytes as base64: the format's header (version 1, key number 1), then filler that differs with `seed`. */
function blobOf(size: number, seed: number): string {
  const bytes = new Uint8Array(size);
  bytes.set([1, 0, 0, 0, 1]);
  for (let i = 5; i < size; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
  return Buffer.from(bytes).toString("base64");
}

/** A world of its own: a fresh database, with the page cap set as `cap` says (left alone when it is undefined). */
async function world(cap?: number): Promise<{ feed: Feed; env: NexusEnv }> {
  const owner: Who = { cookie: (await signInOwner()).cookie };
  const env = await nexusEnv(cap === undefined ? {} : { NEXUS_CHANGES_PAGE_BYTES: String(cap) });
  return { feed: vaultAs(owner, env), env };
}

/** Saves `blob` as the next version of note `id` (which is at `base`) and checks that it was kept. */
async function save(feed: Feed, id: string, base: number, blob: string): Promise<void> {
  expect(bodyOf(await feed.save({ id, blob }, base))).toMatchObject({ result: "saved", id, version: base + 1 });
}

/** Every page of the heads, from the start, following the cursor until a page comes back empty. */
async function readHeads(feed: Feed, limit?: number): Promise<{ pages: Head[][]; next: string }> {
  const pages: Head[][] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const answer = bodyOf(await feed.heads(after, limit));
    expect(Array.isArray(answer.heads)).toBe(true);
    expect(typeof answer.next, "every page names the cursor to carry on from").toBe("string");
    if (answer.heads.length === 0) return { pages, next: answer.next };
    pages.push(answer.heads);
    after = answer.next;
  }
  throw new Error("the heads never ran out");
}

describe("the heads of a vault", () => {
  it("is empty for a vault with no note, and the cursor stays where it was", async () => {
    const { feed } = await world();
    expect(bodyOf(await feed.heads())).toEqual({ heads: [], next: "0" });
    expect(bodyOf(await feed.heads("7"))).toEqual({ heads: [], next: "7" });
  });

  it("gives one version of each note, the newest, with the blob it was saved with, in the order those versions were made", async () => {
    const { feed } = await world();
    // Three notes. a is saved three times, b once, c twice and then deleted, d once, then a is saved again.
    await save(feed, "head-a", 0, blobOf(400, 1));
    await save(feed, "head-b", 0, blobOf(400, 2));
    await save(feed, "head-c", 0, blobOf(400, 3));
    await save(feed, "head-a", 1, blobOf(400, 4));
    await save(feed, "head-c", 1, blobOf(400, 5));
    expect(bodyOf(await feed.remove("head-c", 2))).toMatchObject({ result: "deleted", version: 3 });
    await save(feed, "head-d", 0, blobOf(400, 6));
    await save(feed, "head-a", 2, blobOf(400, 7));

    const { pages, next } = await readHeads(feed);
    const heads = pages.flat();
    // b (made 2nd), c's delete (6th), d (7th) and a's third version (8th): each note once.
    expect(heads.map((h) => [h.id, h.version, h.kind])).toEqual([
      ["head-b", 1, "save"],
      ["head-c", 3, "delete"],
      ["head-d", 1, "save"],
      ["head-a", 3, "save"],
    ]);
    expect(heads[0].blob).toBe(blobOf(400, 2));
    expect(heads[2].blob).toBe(blobOf(400, 6));
    expect(heads[3].blob).toBe(blobOf(400, 7));
    expect(heads[1], "a deleted note is sent as a delete, with no blob").not.toHaveProperty("blob");
    for (const head of heads) {
      expect(head.kid).toBe(1);
      expect(head.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof head.at).toBe("number");
    }
    expect(next, "the end of the heads is the end of the feed: the seq of the last version made, the 8th").toBe("8");
  });

  it("is what the changes feed says is newest, for every note, when notes were saved many times", async () => {
    const { feed } = await world();
    const versions = new Map<string, number>();
    for (let round = 0; round < 4; round++) {
      for (let n = 0; n < 9; n++) {
        const id = `many-${n}`;
        const base = versions.get(id) ?? 0;
        await save(feed, id, base, blobOf(320 + n, round * 10 + n));
        versions.set(id, base + 1);
      }
    }
    // Reading the whole changes feed and keeping the highest version of each note is what a client did before this route.
    const newest = new Map<string, Head>();
    let after: string | undefined;
    for (;;) {
      const page = bodyOf(await feed.changes(after, 5));
      if (page.changes.length === 0) break;
      for (const change of page.changes as Head[]) if ((newest.get(change.id)?.version ?? 0) < change.version) newest.set(change.id, change);
      after = page.next;
    }
    const { pages } = await readHeads(feed, 4);
    const heads = pages.flat();
    expect(heads).toHaveLength(9);
    expect(new Set(heads.map((h) => h.id)).size).toBe(9);
    for (const head of heads) expect(head, head.id).toMatchObject({ version: 4, blob: newest.get(head.id)?.blob, hash: newest.get(head.id)?.hash });
  });

  it("sends one blob a note where the changes feed sends one a version", async () => {
    const { feed } = await world();
    for (let version = 0; version < 5; version++) await save(feed, "once", version, blobOf(2000, version));
    const sent = (heads: Array<{ blob?: string }>) => heads.reduce((total, h) => total + (h.blob?.length ?? 0), 0);
    expect(sent(bodyOf(await feed.heads()).heads)).toBe(blobOf(2000, 4).length);
    expect(sent(bodyOf(await feed.changes()).changes)).toBe(5 * blobOf(2000, 0).length);
  });

  it("says a brought-back note is at its new version, and a note saved again moves to the end", async () => {
    const { feed } = await world();
    await save(feed, "back-a", 0, GARDEN_V1.blob);
    await save(feed, "back-b", 0, PODCAST_V1.blob);
    expect(bodyOf(await feed.remove("back-a", 1))).toMatchObject({ version: 2 });
    await save(feed, "back-a", 2, blobOf(400, 9));
    const heads = (await readHeads(feed)).pages.flat();
    expect(heads.map((h) => [h.id, h.version, h.kind])).toEqual([["back-b", 1, "save"], ["back-a", 3, "save"]]);
  });
});

describe("the pages of the heads", () => {
  it("are cut at the limit, give every note once, and end with an empty page that returns the same cursor", async () => {
    const { feed } = await world();
    for (let n = 0; n < 11; n++) await save(feed, `page-${n}`, 0, blobOf(320, n));
    const { pages, next } = await readHeads(feed, 4);
    expect(pages.map((p) => p.length)).toEqual([4, 4, 3]);
    expect(pages.flat().map((h) => h.id)).toEqual(Array.from({ length: 11 }, (_, n) => `page-${n}`));
    expect(next).toBe("11");
    expect(bodyOf(await feed.heads(next, 4))).toEqual({ heads: [], next: "11" });
  });

  it("start from the cursor they were given: the notes whose newest version is after it", async () => {
    const { feed } = await world();
    for (let n = 0; n < 6; n++) await save(feed, `from-${n}`, 0, blobOf(320, n));
    const answer = bodyOf(await feed.heads("4", 100));
    expect(answer.heads.map((h: Head) => h.id)).toEqual(["from-4", "from-5"]);
    expect(answer.next).toBe("6");
  });

  it("are cut by the size of the blobs as the changes feed's are, and a note larger than the cap goes alone", async () => {
    // 750,000 bytes is 1,000,000 characters of base64: three of them are under a 3,500,000 cap and a fourth would pass it.
    const { feed } = await world(3_500_000);
    for (let n = 0; n < 7; n++) await save(feed, `big-${n}`, 0, blobOf(750_000, n));
    const { pages } = await readHeads(feed);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    for (const page of pages) expect(page.reduce((total, h) => total + (h.blob?.length ?? 0), 0)).toBeLessThanOrEqual(3_500_000);

    const small = await world(1000);
    await save(small.feed, "alone-0", 0, blobOf(2000, 1));
    await save(small.feed, "alone-1", 0, blobOf(2000, 2));
    expect((await readHeads(small.feed)).pages.map((p) => p.map((h) => h.id))).toEqual([["alone-0"], ["alone-1"]]);
  });

  it("cost a deleted note nothing against the cap", async () => {
    const { feed } = await world(3_000);
    for (let n = 0; n < 4; n++) {
      await save(feed, `gone-${n}`, 0, blobOf(2000, n));
      expect(bodyOf(await feed.remove(`gone-${n}`, 1))).toMatchObject({ result: "deleted" });
    }
    const { pages } = await readHeads(feed);
    expect(pages.map((p) => p.length), "four deletes, none with a blob, on one page").toEqual([4]);
  });

  it("miss no note that is saved again while they are being read: it comes round once more at its new version", async () => {
    const { feed } = await world();
    for (let n = 0; n < 6; n++) await save(feed, `live-${n}`, 0, blobOf(320, n));

    const first = bodyOf(await feed.heads(undefined, 3));
    expect(first.heads.map((h: Head) => h.id)).toEqual(["live-0", "live-1", "live-2"]);
    // live-1 was already sent; it is saved again, and live-4, which was not, is saved again too.
    await save(feed, "live-1", 1, blobOf(320, 100));
    await save(feed, "live-4", 1, blobOf(320, 101));
    await save(feed, "live-new", 0, blobOf(320, 102));

    const seen = new Map<string, Head>();
    for (const head of first.heads as Head[]) seen.set(head.id, head);
    let after: string = first.next;
    for (;;) {
      const page = bodyOf(await feed.heads(after, 3));
      if (page.heads.length === 0) break;
      for (const head of page.heads as Head[]) if ((seen.get(head.id)?.version ?? 0) < head.version) seen.set(head.id, head);
      after = page.next;
    }
    expect([...seen.keys()].sort()).toEqual(["live-0", "live-1", "live-2", "live-3", "live-4", "live-5", "live-new"]);
    expect(seen.get("live-1")).toMatchObject({ version: 2, blob: blobOf(320, 100) });
    expect(seen.get("live-4")).toMatchObject({ version: 2, blob: blobOf(320, 101) });
    expect(seen.get("live-0")).toMatchObject({ version: 1, blob: blobOf(320, 0) });
  });
});

describe("the cursor at the end of the heads", () => {
  it("is where the changes feed carries on from: what is made later arrives once, and nothing from before does", async () => {
    const { feed } = await world();
    for (let n = 0; n < 5; n++) await save(feed, `cur-${n}`, 0, blobOf(320, n));
    await save(feed, "cur-2", 1, blobOf(320, 50));
    expect(bodyOf(await feed.remove("cur-3", 1))).toMatchObject({ version: 2 });

    const { next } = await readHeads(feed);
    await save(feed, "cur-late", 0, blobOf(320, 60));
    await save(feed, "cur-0", 1, blobOf(320, 61));

    const later = bodyOf(await feed.changes(next, 100)).changes as Head[];
    expect(later.map((c) => [c.id, c.version])).toEqual([["cur-late", 1], ["cur-0", 2]]);
  });
});

describe("asking for the heads", () => {
  it("refuses a cursor that is not one a previous answer gave, and a limit that is not a whole number of 1 or more, as the changes feed does", async () => {
    const { feed } = await world();
    for (const after of ["abc", "-1", "1.5", "1e3", "9".repeat(16)]) expectRefusal(await feed.heads(after), 400, `cursor ${after}`);
    for (const limit of [0, -3, 1.5, Number.NaN]) expectRefusal(await feed.heads(undefined, limit), 400, `limit ${limit}`);
  });

  it("caps the limit at 500 and takes 100 when none is asked for", async () => {
    const { feed } = await world();
    for (let n = 0; n < 120; n++) await save(feed, `lim-${n}`, 0, blobOf(320, n));
    expect(bodyOf(await feed.heads()).heads).toHaveLength(100);
    expect(bodyOf(await feed.heads(undefined, 100000)).heads).toHaveLength(120);
  });

  it("is a GET route: a POST is refused 405", async () => {
    const { env } = await world();
    const owner = (await signInOwner()).cookie;
    expect((await send("POST", `${API}/heads`, owner, {}, env)).status).toBe(405);
  });
});
