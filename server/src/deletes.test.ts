// Delete in Nexus is a version too. A delete marks the note deleted: gone from the list, still readable through its
// history, and brought back by a save that starts from the delete's version. A delete names the version it starts from,
// like a save does, so it never removes edits it did not see. (There is no move: a rename is a new blob with the new path
// inside it, which the server cannot see.) Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the
// routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, GARDEN_V2, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault, type Answer } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

type Entry = { version: number; kind: string };

const idsIn = (answer: Answer): string[] => bodyOf(answer).notes.map((n: { id: string }) => n.id).sort();
const kinds = (answer: Answer): Array<[number, string]> => bodyOf(answer).versions.map((v: Entry) => [v.version, v.kind]);

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

describe("deleting a note", () => {
  it("hides it from the list, keeps its history, and answers the delete as the next version", async () => {
    bodyOf(await owner.save({ id: "del-gone", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "del-gone", blob: GARDEN_V2.blob }, 1));
    bodyOf(await owner.save({ id: "del-stays", blob: PODCAST_V1.blob }, 0));
    expect(idsIn(await owner.list())).toEqual(["del-gone", "del-stays"]);

    expect(bodyOf(await owner.remove("del-gone", 2))).toEqual({ result: "deleted", id: "del-gone", version: 3 });

    expect(idsIn(await owner.list())).toEqual(["del-stays"]);
    expectRefusal(await owner.note("del-gone"), 404, "the latest of a deleted note");

    // The history is all still there, ending in the delete, and every old version still reads.
    expect(kinds(await owner.history("del-gone"))).toEqual([[1, "save"], [2, "save"], [3, "delete"]]);
    expect(bodyOf(await owner.note("del-gone", 2))).toMatchObject({ version: 2, kind: "save", blob: GARDEN_V2.blob });
    // The delete version itself reads as a delete, and keeps the blob it followed.
    expect(bodyOf(await owner.note("del-gone", 3))).toMatchObject({ version: 3, kind: "delete", blob: GARDEN_V2.blob });
  });

  it("is undone by a save that starts from the delete's version", async () => {
    bodyOf(await owner.save({ id: "del-restore", blob: GARDEN_V1.blob }, 0));
    expect(bodyOf(await owner.remove("del-restore", 1)).version).toBe(2);

    expect(bodyOf(await owner.save({ id: "del-restore", blob: GARDEN_V2.blob }, 2))).toMatchObject({ result: "saved", version: 3 });

    expect(bodyOf(await owner.note("del-restore"))).toMatchObject({ version: 3, kind: "save", blob: GARDEN_V2.blob });
    expect(idsIn(await owner.list())).toContain("del-restore");
    expect(kinds(await owner.history("del-restore"))).toEqual([[1, "save"], [2, "delete"], [3, "save"]]);
  });

  it("is refused for a save that started before the delete, which does not bring the note back", async () => {
    bodyOf(await owner.save({ id: "del-stale-save", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.remove("del-stale-save", 1));
    const stale = await owner.save({ id: "del-stale-save", blob: GARDEN_V2.blob }, 1);
    expectRefusal(stale, 409, "a save that started before the delete");
    expect(stale.body.current).toBe(2);
    expectRefusal(await owner.note("del-stale-save"), 404, "the note stays deleted");
  });

  it("is refused for a delete that started from an older version, and removes nothing", async () => {
    bodyOf(await owner.save({ id: "del-stale", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.save({ id: "del-stale", blob: GARDEN_V2.blob }, 1));
    const stale = await owner.remove("del-stale", 1);
    expectRefusal(stale, 409, "a delete of a note that has moved on");
    expect(stale.body.current).toBe(2);
    expect(bodyOf(await owner.note("del-stale"))).toMatchObject({ version: 2, blob: GARDEN_V2.blob });
    expect(idsIn(await owner.list())).toContain("del-stale");
  });

  it("answers 404 for a note that is not there, and for one that is already deleted", async () => {
    expectRefusal(await owner.remove("del-never-was", 0), 404, "a delete of a note that is not there");
    bodyOf(await owner.save({ id: "del-twice", blob: GARDEN_V1.blob }, 0));
    bodyOf(await owner.remove("del-twice", 1));
    expectRefusal(await owner.remove("del-twice", 2), 404, "a second delete");
    expect(kinds(await owner.history("del-twice"))).toEqual([[1, "save"], [2, "delete"]]);
  });

  it("needs the version it starts from, and only the fields of a delete", async () => {
    bodyOf(await owner.save({ id: "del-fields", blob: GARDEN_V1.blob }, 0));
    expectRefusal(await send("POST", `${API}/delete`, cookie, { id: "del-fields" }), 400, "a delete with no base");
    expectRefusal(await send("POST", `${API}/delete`, cookie, { base: 1 }), 400, "a delete with no id");
    expectRefusal(await send("POST", `${API}/delete`, cookie, {}), 400, "a delete with nothing");
    expectRefusal(await send("POST", `${API}/delete`, cookie, { id: "del-fields", base: 1, path: "Projects/Garden plan.md" }), 400, "a delete in the old shape");
    expect(bodyOf(await owner.note("del-fields")).version, "none of them deleted it").toBe(1);
  });
});

describe("there is no move", () => {
  it("answers 404 to the old move route, and a rename is a save of a new blob", async () => {
    expectRefusal(await send("POST", `${API}/move`, cookie, { from: "a", to: "b" }), 404, "the old move route");
    bodyOf(await owner.save({ id: "rename-me", blob: GARDEN_V1.blob }, 0));
    // The device writes the new path inside the blob and saves it as the next version of the same id: history stays.
    expect(bodyOf(await owner.save({ id: "rename-me", blob: GARDEN_V2.blob }, 1)).version).toBe(2);
    expect(kinds(await owner.history("rename-me"))).toEqual([[1, "save"], [2, "save"]]);
  });
});
