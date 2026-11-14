// Move and delete in Nexus are versions too. A move keeps the note's history under its new path. A delete marks the
// note deleted: gone from the list and the search, still readable through its history, and brought back by a save.
// Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, vault, type Answer } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

type Entry = { version: number; kind: string };

const pathsIn = (answer: Answer): string[] => bodyOf(answer).notes.map((n: { path: string }) => n.path).sort();
const kinds = (answer: Answer): Array<[number, string]> => bodyOf(answer).versions.map((v: Entry) => [v.version, v.kind]);

beforeAll(async () => {
  await setUpNexus();
  owner = vault((await signInOwner()).cookie);
});

describe("moving a note", () => {
  it("keeps its history under the new path and takes the old path out of the list", async () => {
    bodyOf(await owner.save("Move history/old name.md", "first words\n"));
    bodyOf(await owner.save("Move history/old name.md", "first words\nsecond words\n", { base: 1 }));

    const moved = await owner.move("Move history/old name.md", "Move history/new name.md");
    expect(bodyOf(moved)).toMatchObject({ result: "moved", path: "Move history/new name.md", version: 3 });

    // Same text, the move is the next version.
    expect(bodyOf(await owner.note("Move history/new name.md"))).toMatchObject({
      path: "Move history/new name.md", version: 3, text: "first words\nsecond words\n",
    });

    // The whole history came with it, old versions readable with the text they held.
    expect(kinds(await owner.history("Move history/new name.md"))).toEqual([[1, "save"], [2, "save"], [3, "move"]]);
    expect(bodyOf(await owner.note("Move history/new name.md", 1)).text).toBe("first words\n");

    // The old path is gone; the new one is listed.
    expectRefusal(await owner.note("Move history/old name.md"), 404, "the old path");
    expect(pathsIn(await owner.list("Move history"))).toEqual(["Move history/new name.md"]);
  });

  it("can then be saved from the move's version", async () => {
    bodyOf(await owner.save("Moving/before.md", "one\n"));
    expect(bodyOf(await owner.move("Moving/before.md", "Moving/after.md")).version).toBe(2);
    const next = await owner.save("Moving/after.md", "one\ntwo\n", { base: 2 });
    expect(bodyOf(next)).toMatchObject({ result: "saved", version: 3 });
  });

  it("refuses to move onto a note that exists, and leaves both as they were", async () => {
    bodyOf(await owner.save("Moving/keep.md", "I stay\n"));
    bodyOf(await owner.save("Moving/other.md", "so do I\n"));
    expectRefusal(await owner.move("Moving/keep.md", "Moving/other.md"), 409, "a move onto a note");
    expect(bodyOf(await owner.note("Moving/keep.md"))).toMatchObject({ version: 1, text: "I stay\n" });
    expect(bodyOf(await owner.note("Moving/other.md"))).toMatchObject({ version: 1, text: "so do I\n" });
  });

  it("answers 404 for a note that is not there", async () => {
    bodyOf(await owner.save("Moving/exists.md", "here\n"));
    expectRefusal(await owner.move("Moving/never was.md", "Moving/anywhere.md"), 404, "a move of a note that is not there");
  });
});

describe("deleting a note", () => {
  it("hides it from the list and the search, keeps its history, and answers the delete as the next version", async () => {
    bodyOf(await owner.save("Delete hides/gone.md", "a unique marker: quokka\n"));
    bodyOf(await owner.save("Delete hides/gone.md", "a unique marker: quokka\nand more\n", { base: 1 }));
    bodyOf(await owner.save("Delete hides/stays.md", "still here\n"));
    expect(pathsIn(await owner.list("Delete hides"))).toEqual(["Delete hides/gone.md", "Delete hides/stays.md"]);
    expect(bodyOf(await owner.search("quokka")).results.map((r: { path: string }) => r.path)).toEqual(["Delete hides/gone.md"]);

    const deleted = await owner.remove("Delete hides/gone.md");
    expect(bodyOf(deleted)).toMatchObject({ result: "deleted", path: "Delete hides/gone.md", version: 3 });

    expect(pathsIn(await owner.list("Delete hides"))).toEqual(["Delete hides/stays.md"]);
    expect(bodyOf(await owner.search("quokka")).results).toEqual([]);
    expectRefusal(await owner.note("Delete hides/gone.md"), 404, "the latest of a deleted note");

    // The history is all still there, ending in the delete, and every old version still reads.
    expect(kinds(await owner.history("Delete hides/gone.md"))).toEqual([[1, "save"], [2, "save"], [3, "delete"]]);
    expect(bodyOf(await owner.note("Delete hides/gone.md", 2))).toMatchObject({ version: 2, text: "a unique marker: quokka\nand more\n" });
  });

  it("is undone by a save that starts from the delete's version", async () => {
    bodyOf(await owner.save("Deleting/restore.md", "before the delete\n"));
    expect(bodyOf(await owner.remove("Deleting/restore.md")).version).toBe(2);

    const restored = await owner.save("Deleting/restore.md", "after the restore\n", { base: 2 });
    expect(bodyOf(restored)).toMatchObject({ result: "saved", version: 3 });

    expect(bodyOf(await owner.note("Deleting/restore.md"))).toMatchObject({ version: 3, text: "after the restore\n" });
    expect(pathsIn(await owner.list("Deleting"))).toEqual(["Deleting/restore.md"]);
    expect(kinds(await owner.history("Deleting/restore.md"))).toEqual([[1, "save"], [2, "delete"], [3, "save"]]);
  });

  it("answers 404 for a note that is not there", async () => {
    bodyOf(await owner.save("Delete missing/exists.md", "here\n"));
    expectRefusal(await owner.remove("Delete missing/never was.md"), 404, "a delete of a note that is not there");
  });
});
