// Reading from Nexus: one note (latest, or a given version), a note's history, a folder's list and a plain text
// search over the latest versions. Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the
// routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, vault, type Answer } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

const pathsIn = (answer: Answer): string[] => bodyOf(answer).notes.map((n: { path: string }) => n.path).sort();
const found = (answer: Answer): string[] => bodyOf(answer).results.map((r: { path: string }) => r.path).sort();

beforeAll(async () => {
  await setUpNexus();
  owner = vault((await signInOwner()).cookie);
});

describe("reading one note", () => {
  it("gives the latest version, or the version asked for", async () => {
    bodyOf(await owner.save("Read/three.md", "v1\n"));
    bodyOf(await owner.save("Read/three.md", "v2\n", { base: 1 }));
    bodyOf(await owner.save("Read/three.md", "v3\n", { base: 2 }));

    expect(bodyOf(await owner.note("Read/three.md"))).toMatchObject({ path: "Read/three.md", version: 3, text: "v3\n" });
    expect(bodyOf(await owner.note("Read/three.md", 1))).toMatchObject({ path: "Read/three.md", version: 1, text: "v1\n" });
    expect(bodyOf(await owner.note("Read/three.md", 2))).toMatchObject({ path: "Read/three.md", version: 2, text: "v2\n" });
  });

  it("answers 404 with a reason for a note or a version that is not there", async () => {
    bodyOf(await owner.save("Read/real.md", "here\n"));
    expectRefusal(await owner.note("Read/not real.md"), 404, "a note that is not there");
    expectRefusal(await owner.note("Read/real.md", 9), 404, "a version that is not there");
    expectRefusal(await owner.history("Read/not real.md"), 404, "the history of a note that is not there");
  });
});

describe("a folder's list", () => {
  it("holds the live notes under the folder, each with its latest number, its time and its clash flag", async () => {
    bodyOf(await owner.save("Listing/Ideas/a.md", "a\n"));
    bodyOf(await owner.save("Listing/Ideas/b.md", "b1\n"));
    bodyOf(await owner.save("Listing/Ideas/b.md", "b2\n", { base: 1 }));
    bodyOf(await owner.save("Listing/Work/c.md", "c\n"));

    const ideas = await owner.list("Listing/Ideas");
    expect(pathsIn(ideas)).toEqual(["Listing/Ideas/a.md", "Listing/Ideas/b.md"]);
    const b = bodyOf(ideas).notes.find((n: { path: string }) => n.path === "Listing/Ideas/b.md");
    expect(b).toMatchObject({ version: 2, clash: false });
    expect(typeof b.at).toBe("number");

    expect(pathsIn(await owner.list("Listing/Work"))).toEqual(["Listing/Work/c.md"]);
  });

  it("is a folder and not a name that starts the same way, and keeps the case of a path", async () => {
    bodyOf(await owner.save("Folders/Ideas/in.md", "in\n"));
    bodyOf(await owner.save("Folders/Ideas2/near.md", "near\n"));
    bodyOf(await owner.save("Folders/ideas/lower.md", "lower\n"));
    bodyOf(await owner.save("Folders/Ideas/Case.md", "upper case\n"));
    bodyOf(await owner.save("Folders/Ideas/case.md", "lower case\n"));

    expect(pathsIn(await owner.list("Folders/Ideas"))).toEqual(["Folders/Ideas/Case.md", "Folders/Ideas/case.md", "Folders/Ideas/in.md"]);
    expect(pathsIn(await owner.list("Folders/ideas"))).toEqual(["Folders/ideas/lower.md"]);
    // Two paths that differ only in case are two notes.
    expect(bodyOf(await owner.note("Folders/Ideas/Case.md")).text).toBe("upper case\n");
    expect(bodyOf(await owner.note("Folders/Ideas/case.md")).text).toBe("lower case\n");
  });

  it("with no folder holds every live note", async () => {
    bodyOf(await owner.save("Whole vault/x.md", "x\n"));
    bodyOf(await owner.save("Whole vault/deep/er/y.md", "y\n"));
    const all = pathsIn(await owner.list());
    expect(all).toContain("Whole vault/x.md");
    expect(all).toContain("Whole vault/deep/er/y.md");
  });
});

describe("a plain text search over the latest versions", () => {
  it("finds a note by a word in its latest text and returns its path and latest number", async () => {
    bodyOf(await owner.save("Search/found.md", "a note about a giraffe\n"));
    bodyOf(await owner.save("Search/other.md", "a note about a zebra\n"));
    expect(bodyOf(await owner.search("giraffe")).results).toEqual([expect.objectContaining({ path: "Search/found.md", version: 1 })]);
  });

  it("looks only at the latest version: a word that an edit removed no longer finds the note", async () => {
    bodyOf(await owner.save("Search/edited.md", "first draft says okapi\n"));
    bodyOf(await owner.save("Search/edited.md", "second draft says tapir\n", { base: 1 }));
    expect(found(await owner.search("okapi"))).toEqual([]);
    expect(found(await owner.search("tapir"))).toEqual(["Search/edited.md"]);
  });

  it("does not look inside a clash version, which is not the note's text", async () => {
    bodyOf(await owner.save("Search/clashing.md", "one\ntwo\nthree\n"));
    bodyOf(await owner.save("Search/clashing.md", "one\nTWO\nthree\n", { base: 1 }));
    expect(bodyOf(await owner.save("Search/clashing.md", "one\nwombat\nthree\n", { base: 1 }), 409).result).toBe("clash");
    expect(found(await owner.search("wombat"))).toEqual([]);
    expect(found(await owner.search("TWO"))).toEqual(["Search/clashing.md"]);
  });

  it("takes the words as plain text: a percent sign or an underscore is not a wildcard", async () => {
    bodyOf(await owner.save("Search/percent.md", "growth of 100% this year\n"));
    bodyOf(await owner.save("Search/digits.md", "1000 things and 1_000 more\n"));
    bodyOf(await owner.save("Search/underscore.md", "snake_case name\n"));
    bodyOf(await owner.save("Search/plain.md", "snakeXcase name\n"));
    expect(found(await owner.search("100%"))).toEqual(["Search/percent.md"]);
    expect(found(await owner.search("snake_case"))).toEqual(["Search/underscore.md"]);
  });
});
