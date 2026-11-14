// Reading from Nexus: one note (latest, or a given version), a note's history and the list of live notes. Through the
// Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes and the shape of every answer). There is no
// search and no folder: the server holds blobs it cannot read, so finding a note by its words or its folder is for the
// device, which holds the key.

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, GARDEN_V2, PODCAST_KID_7, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

describe("reading one note", () => {
  it("gives the latest version, or the version asked for", async () => {
    bodyOf(await owner.save({ id: "read-three", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "read-three", blob: GARDEN_V2.blob }, 1));
    bodyOf(await owner.save({ id: "read-three", blob: PODCAST_V1.blob }, 2));

    expect(bodyOf(await owner.note("read-three"))).toMatchObject({ id: "read-three", version: 3, blob: PODCAST_V1.blob });
    expect(bodyOf(await owner.note("read-three", 1))).toMatchObject({ id: "read-three", version: 1, blob: GARDEN_V1.blob });
    expect(bodyOf(await owner.note("read-three", 2))).toMatchObject({ id: "read-three", version: 2, blob: GARDEN_V2.blob });
  });

  it("gives every field the contract names, and no others", async () => {
    bodyOf(await owner.save({ id: "read-fields", blob: GARDEN_V1.blob }, 0));
    const read = bodyOf(await owner.note("read-fields"));
    expect(Object.keys(read).sort()).toEqual(["at", "blob", "hash", "id", "kid", "kind", "version", "writer"]);
  });

  it("answers 404 with a reason for a note or a version that is not there", async () => {
    bodyOf(await owner.save({ id: "read-real", blob: GARDEN_V1.blob }, 0));
    expectRefusal(await owner.note("read-not-real"), 404, "a note that is not there");
    expectRefusal(await owner.note("read-real", 9), 404, "a version that is not there");
    expectRefusal(await owner.history("read-not-real"), 404, "the history of a note that is not there");
  });

  it("refuses a version that is not a whole number from 1", async () => {
    bodyOf(await owner.save({ id: "read-version", blob: GARDEN_V1.blob }, 0));
    for (const asked of ["one", "0", "1.5", "-1"]) {
      expectRefusal(await send("GET", `${API}/note?id=read-version&version=${asked}`, cookie), 400, `a version of ${asked}`);
    }
  });
});

describe("a note's history", () => {
  it("is every version, oldest first, with its kind, key number, writer, time and hash, and no blob", async () => {
    // The second version is under another vault key, as a note is after the key is changed.
    bodyOf(await owner.save({ id: "hist-1", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "hist-1", blob: PODCAST_KID_7.blob }, 1, PODCAST_KID_7.kid));
    const history = bodyOf(await owner.history("hist-1"));
    expect(history.versions.map((v: { version: number; kid: number }) => [v.version, v.kid])).toEqual([[1, 1], [2, 7]]);
    for (const v of history.versions) {
      expect(Object.keys(v).sort()).toEqual(["at", "hash", "kid", "kind", "version", "writer"]);
    }
  });
});

describe("the list of notes", () => {
  it("holds the live notes by id, each with its latest number, its time, its key number and its hash", async () => {
    bodyOf(await owner.save({ id: "list-a", blob: PODCAST_KID_7.blob }, 0, PODCAST_KID_7.kid));
    bodyOf(await owner.save({ id: "list-b", blob: PODCAST_V1.blob }, 0));
    bodyOf(await owner.save({ id: "list-b", blob: GARDEN_V2.blob }, 1));

    const notes = bodyOf(await owner.list()).notes as Array<{ id: string; version: number; at: number; kid: number; hash: string }>;
    const a = notes.find((n) => n.id === "list-a");
    const b = notes.find((n) => n.id === "list-b");
    expect(a).toMatchObject({ version: 1, kid: 7 });
    expect(b).toMatchObject({ version: 2, kid: 1 });
    expect(typeof a?.at).toBe("number");
    expect(Object.keys(a ?? {}).sort()).toEqual(["at", "hash", "id", "kid", "version"]);
    expect(b?.hash, "the hash of the latest version, not the first").toBe(bodyOf(await owner.note("list-b", 2)).hash);
  });

  it("is in order of id, and has no blob in it", async () => {
    const notes = bodyOf(await owner.list()).notes as Array<Record<string, unknown>>;
    const ids = notes.map((n) => n.id as string);
    expect(ids).toEqual([...ids].sort());
    for (const n of notes) expect(n).not.toHaveProperty("blob");
  });

  it("has no folder to ask for: a folder in the query changes nothing, and there is no search route", async () => {
    const all = bodyOf(await owner.list()).notes;
    expect(bodyOf(await send("GET", `${API}/list?folder=Ideas`, cookie)).notes).toEqual(all);
    expectRefusal(await send("GET", `${API}/search?q=garden`, cookie), 404, "the old search route");
  });
});
