// Saving a note in Nexus: a note is an encrypted blob under an id the device chose, every save is a version, and a save
// names the version it started from. A save that started from any other version than the note's latest is refused
// with the version the note is at, and the device merges and saves again (the server cannot read a note, so it never
// merges). Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes and the shape of
// every answer).

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, GARDEN_V2, PODCAST_KID_0, PODCAST_KID_7, PODCAST_KID_MAX, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

type Entry = { version: number; kind: string; kid: number; writer: string; at: number; hash: string };

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

/** SHA-256 of the bytes a base64 text stands for, worked out here with Node's own hash. */
const sha256OfBlob = (blob: string): string => createHash("sha256").update(Buffer.from(blob, "base64")).digest("hex");

/** A save written out by hand, for the requests that are wrong in some way. */
const rawSave = (body: unknown) => send("POST", `${API}/save`, cookie, body);

describe("the worked example: a save at version 0, a second one at version 0, and the feed", () => {
  it("stores the first, refuses the second with the current version 1, and lists n-1 at version 1", async () => {
    expect(bodyOf(await owner.save(GARDEN_V1, 0))).toEqual({ result: "saved", id: "n-1", version: 1 });

    const second = await owner.save(GARDEN_V2, 0);
    expectRefusal(second, 409, "a second save at version 0");
    expect(second.body.current).toBe(1);

    const feed = bodyOf(await owner.changes());
    expect(feed.changes.map((c: { id: string; version: number }) => [c.id, c.version])).toEqual([["n-1", 1]]);
    expect(bodyOf(await owner.note("n-1"))).toMatchObject({ version: 1, blob: GARDEN_V1.blob });
  });
});

describe("a first save and the saves after it", () => {
  it("keeps the blob exactly as sent, with the kid, who saved it, when, and SHA-256 of the blob", async () => {
    const before = Date.now();
    expect(bodyOf(await owner.save(PODCAST_KID_7, 0, PODCAST_KID_7.kid))).toMatchObject({ result: "saved", id: PODCAST_KID_7.id, version: 1 });

    const read = bodyOf(await owner.note(PODCAST_KID_7.id));
    expect(read).toMatchObject({ id: PODCAST_KID_7.id, version: 1, kind: "save", kid: 7, blob: PODCAST_KID_7.blob, writer: "owner" });
    expect(read.at).toBeGreaterThanOrEqual(before);
    expect(read.at).toBeLessThanOrEqual(Date.now());
    expect(read.hash).toBe(sha256OfBlob(PODCAST_KID_7.blob));
    expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes the next version when the save starts from the latest one, and never changes an old version", async () => {
    bodyOf(await owner.save({ id: "next-1", blob: GARDEN_V1.blob }, 0));
    expect(bodyOf(await owner.save({ id: "next-1", blob: GARDEN_V2.blob }, 1))).toMatchObject({ result: "saved", id: "next-1", version: 2 });

    expect(bodyOf(await owner.note("next-1"))).toMatchObject({ version: 2, blob: GARDEN_V2.blob });
    expect(bodyOf(await owner.note("next-1", 1))).toMatchObject({ version: 1, blob: GARDEN_V1.blob });
    expect(bodyOf(await owner.note("next-1", 2))).toMatchObject({ version: 2, blob: GARDEN_V2.blob });

    const history = bodyOf(await owner.history("next-1"));
    expect(history.id).toBe("next-1");
    expect(history.versions.map((v: Entry) => v.version)).toEqual([1, 2]);
    for (const entry of history.versions as Entry[]) {
      expect(entry).toMatchObject({ kind: "save", kid: 1, writer: "owner" });
      expect(typeof entry.at).toBe("number");
      expect(entry).not.toHaveProperty("blob");
    }
    expect(history.versions.map((v: Entry) => v.hash)).toEqual([sha256OfBlob(GARDEN_V1.blob), sha256OfBlob(GARDEN_V2.blob)]);
  });

  it("gives the same blob the same hash and a different blob a different one", async () => {
    bodyOf(await owner.save({ id: "hash-one", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "hash-two", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "hash-three", blob: GARDEN_V2.blob }, 0));
    const hashOf = async (id: string): Promise<string> => bodyOf(await owner.note(id)).hash;
    expect(await hashOf("hash-one")).toBe(await hashOf("hash-two"));
    expect(await hashOf("hash-one")).not.toBe(await hashOf("hash-three"));
  });

  it("keeps blobs of any length up to the limit, down to the smallest blob and up to the largest the limit allows", async () => {
    const sizes: Record<string, number> = { "size-smallest": 301, "size-odd": 1001, "size-limit": 1_000_000 };
    for (const [id, size] of Object.entries(sizes)) {
      // Only the header has to be right (blob-header.test.ts): version 1 and kid 1, then bytes the server never reads.
      const bytes = Buffer.alloc(size, 0xa5);
      bytes.set([1, 0, 0, 0, 1]);
      bytes[size - 1] = 255;
      const blob = bytes.toString("base64");
      bodyOf(await owner.save({ id, blob }, 0));
      const read = bodyOf(await owner.note(id));
      expect(read.blob, id).toBe(blob);
      expect(read.hash, id).toBe(sha256OfBlob(blob));
    }
  });

  it("is a different note for each id, and the id is all that names it", async () => {
    bodyOf(await owner.save({ id: "same-bytes-a", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "same-bytes-b", blob: GARDEN_V1.blob }, 0));
    const listed = bodyOf(await owner.list()).notes.map((n: { id: string }) => n.id);
    expect(listed).toEqual(expect.arrayContaining(["same-bytes-a", "same-bytes-b"]));
  });
});

describe("a save that did not start from the latest version is refused, and keeps nothing", () => {
  it("is told the version the note is at, and the note and its history are as they were", async () => {
    bodyOf(await owner.save({ id: "stale-1", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "stale-1", blob: GARDEN_V2.blob }, 1));

    const behind = await owner.save({ id: "stale-1", blob: PODCAST_V1.blob }, 1);
    expectRefusal(behind, 409, "a save that started from version 1 of a note at version 2");
    expect(behind.body.current).toBe(2);
    expect(behind.body.error).toMatch(/version 2/);

    const ahead = await owner.save({ id: "stale-1", blob: PODCAST_V1.blob }, 5);
    expectRefusal(ahead, 409, "a save that started from a version the note never had");
    expect(ahead.body.current).toBe(2);

    expect(bodyOf(await owner.note("stale-1"))).toMatchObject({ version: 2, blob: GARDEN_V2.blob });
    expect(bodyOf(await owner.history("stale-1")).versions).toHaveLength(2);
  });

  it("is saved again from the version it was told, which is how a device merges", async () => {
    bodyOf(await owner.save({ id: "stale-2", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "stale-2", blob: GARDEN_V2.blob }, 1));
    const refused = await owner.save({ id: "stale-2", blob: PODCAST_V1.blob }, 1);
    expect(refused.status).toBe(409);
    // The device would now read the note, merge its edit into it and save the merge from `current`.
    expect(bodyOf(await owner.save({ id: "stale-2", blob: PODCAST_V1.blob }, refused.body.current))).toMatchObject({ result: "saved", version: 3 });
  });

  it("says the note is at version 0 when there is no such note, for a base above 0", async () => {
    const answer = await owner.save({ id: "never-made", blob: GARDEN_V1.blob }, 3);
    expectRefusal(answer, 409, "a save that starts from a version of a note the server has not got");
    expect(answer.body.current).toBe(0);
    expectRefusal(await owner.note("never-made"), 404, "the note the refused save tried to make");
    expect(bodyOf(await owner.changes()).changes.some((c: { id: string }) => c.id === "never-made")).toBe(false);
  });

  it("never merges, even for two edits that touch different lines: the server cannot tell", async () => {
    bodyOf(await owner.save({ id: "no-merge", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "no-merge", blob: GARDEN_V2.blob }, 1));
    expect((await owner.save({ id: "no-merge", blob: PODCAST_V1.blob }, 1)).status).toBe(409);
    expect(bodyOf(await owner.history("no-merge")).versions.map((v: Entry) => v.kind)).toEqual(["save", "save"]);
  });
});

describe("a save that is not a save is refused, and keeps nothing", () => {
  it("is refused with 400 for a missing id, base, kid or blob", async () => {
    const whole = { id: "bad-whole", base: 0, kid: 1, blob: GARDEN_V1.blob };
    for (const field of ["id", "base", "kid", "blob"] as const) {
      const { [field]: _left, ...without } = whole;
      expectRefusal(await rawSave(without), 400, `a save with no ${field}`);
    }
    expectRefusal(await send("GET", `${API}/note?id=bad-whole`, cookie), 404, "the note none of them made");
  });

  it("is refused with 400 for a base that is not a whole number from 0, or a kid that is not a key number", async () => {
    const body = { id: "bad-numbers", kid: 1, blob: GARDEN_V1.blob };
    for (const base of ["one", "0", -1, 1.5, null, true, [0]]) {
      expectRefusal(await rawSave({ ...body, base }), 400, `a base of ${JSON.stringify(base)}`);
    }
    for (const kid of ["1", -1, 1.5, 4294967296, null, undefined]) {
      expectRefusal(await rawSave({ ...body, base: 0, kid }), 400, `a kid of ${JSON.stringify(kid)}`);
    }
    for (const { kid, blob } of [PODCAST_KID_0, { kid: 1, blob: GARDEN_V1.blob }, PODCAST_KID_MAX]) {
      expect((await rawSave({ id: `kid-${kid}`, base: 0, kid, blob })).status, `kid ${kid}`).toBe(200);
    }
    expectRefusal(await send("GET", `${API}/note?id=bad-numbers`, cookie), 404, "the note none of them made");
  });

  it("is refused with 400 for a blob that is not base64 exactly as it would be written, and for an empty one", async () => {
    const body = { id: "bad-blob", base: 0, kid: 1 };
    const real = GARDEN_V1.blob;
    for (const [blob, what] of [
      ["", "an empty blob"],
      ["not base64 at all!", "characters that are not base64"],
      [real.slice(0, -1), "a length that is not a multiple of four"],
      [real.replace(/=+$/, "") + "====", "padding in the wrong place"],
      ["AB==", "spare bits that are not zero"],
      ["AAB=", "spare bits that are not zero, one byte shorter"],
      [real.replace(/\+/g, "-").replace(/\//g, "_") + "!", "url-safe characters beside others"],
      [`${real}\n`, "a line break"],
      [42, "a number"],
      [[real], "a list"],
    ] as const) {
      expectRefusal(await rawSave({ ...body, blob }), 400, what);
    }
    // A canonical one-byte blob is base64 as it should be written, so it gets as far as the header check, which refuses it.
    const short = await rawSave({ ...body, blob: "AA==" });
    expectRefusal(short, 400, "a canonical one-byte blob");
    expect(short.body.reason).toBe("not-an-encrypted-blob");
  });

  it("is refused with 413 for a blob over the limit, and the largest is kept", async () => {
    const tooLong = Buffer.alloc(1_000_001, 1).toString("base64");
    expectRefusal(await rawSave({ id: "too-long", base: 0, kid: 1, blob: tooLong }), 413, "a blob one byte over the limit");
    expectRefusal(await send("GET", `${API}/note?id=too-long`, cookie), 404, "the note the refused save tried to make");
  });

  it("is refused with 400 for a field that is not one of id, base, kid and blob, and nothing is kept or echoed", async () => {
    // What an old client sends: the path and the text in plain.
    const legacy = await rawSave({ path: "Projects/Garden plan.md", text: GARDEN_V1.text, base: 1 });
    expectRefusal(legacy, 400, "a save in the old plain shape");
    expect(legacy.text, "the refusal repeats nothing it was sent").not.toContain("Garden plan");
    expect(legacy.text).not.toContain(GARDEN_V1.text.slice(0, 10));

    const extra = await rawSave({ id: "extra-field", base: 0, kid: 1, blob: GARDEN_V1.blob, path: "Projects/Garden plan.md" });
    expectRefusal(extra, 400, "a good save with a path beside it");
    expect(extra.body.error).toContain("id, base, kid, blob");
    expectRefusal(await send("GET", `${API}/note?id=extra-field`, cookie), 404, "the note the refused save tried to make");
  });
});

describe("two saves at the same moment", () => {
  it("make one version: one is saved, the other is told the note is at the version the first made", async () => {
    bodyOf(await owner.save({ id: "race-1", blob: GARDEN_V1.blob }, 0));
    const [a, b] = await Promise.all([
      owner.save({ id: "race-1", blob: GARDEN_V2.blob }, 1),
      owner.save({ id: "race-1", blob: PODCAST_V1.blob }, 1),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.current).toBe(2);

    const history = bodyOf(await owner.history("race-1"));
    expect(history.versions.map((v: Entry) => v.version), "no gap and no repeated number").toEqual([1, 2]);
    const saved = a.status === 200 ? GARDEN_V2 : PODCAST_V1;
    expect(bodyOf(await owner.note("race-1")).blob, "the one that was saved is the note").toBe(saved.blob);
  });

  it("make one note when the note is new: one is version 1 and the other is told the note is at 1", async () => {
    const [a, b] = await Promise.all([
      owner.save({ id: "race-new", blob: GARDEN_V1.blob }, 0),
      owner.save({ id: "race-new", blob: GARDEN_V2.blob }, 0),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).body.current).toBe(1);
    expect(bodyOf(await owner.history("race-new")).versions).toHaveLength(1);
  });

  it("keep the changes feed's numbering whole when different notes are saved together", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, n) => owner.save({ id: `together-${n}`, blob: GARDEN_V1.blob }, 0)));
    const ids = bodyOf(await owner.changes(undefined, 500)).changes.map((c: { id: string }) => c.id).filter((id: string) => id.startsWith("together-"));
    expect(ids.sort()).toEqual(Array.from({ length: 6 }, (_, n) => `together-${n}`));
  });
});
