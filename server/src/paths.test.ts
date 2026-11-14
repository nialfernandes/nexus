// A note's path is its identity: any folder depth, spaces, accents and emoji come back exactly as they went in,
// and a path that leaves the vault (`../` anywhere, or an absolute path) is refused with 400 and stores nothing.
// Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

beforeAll(async () => {
  await setUpNexus();
  owner = vault((await signInOwner()).cookie);
});

const ROUND_TRIPS = [
  "Ideas/Podcast names.md",
  "Café/Résumé notes.md",
  "Daily/2026-11-13 🎙️ idea ✨.md",
  "日本語/ノート.md",
  "One/Two/Three/Four/Five/Six/deep note.md",
  "Q&A #1 100% + more.md",
  "Ideas/v1..v2 notes.md",
];

describe("paths that are not plain", () => {
  it.each(ROUND_TRIPS)("%s goes in and comes back exactly", async (path) => {
    const text = `the text of ${path}\n`;
    expect(bodyOf(await owner.save(path, text))).toMatchObject({ result: "saved", path, version: 1 });
    expect(bodyOf(await owner.note(path))).toMatchObject({ path, version: 1, text });
    expect(bodyOf(await owner.history(path)).path).toBe(path);

    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
    expect(bodyOf(await owner.list(folder)).notes.map((n: { path: string }) => n.path)).toContain(path);
    expect(bodyOf(await owner.search(`the text of ${path}`)).results.map((r: { path: string }) => r.path)).toContain(path);
  });

  it("can be moved to another such path, and come back under it", async () => {
    bodyOf(await owner.save("Moves/Café notes.md", "café\n"));
    const moved = bodyOf(await owner.move("Moves/Café notes.md", "Moves/🎙️ café notes.md"));
    expect(moved.path).toBe("Moves/🎙️ café notes.md");
    expect(bodyOf(await owner.note("Moves/🎙️ café notes.md")).text).toBe("café\n");
  });
});

const OUTSIDE_THE_VAULT = [
  "../escape.md",
  "Ideas/../../escape.md",
  "a/b/../../../escape.md",
  "Ideas/..",
  "..",
  "/etc/escape.md",
  "/escape.md",
];

/** A note inside the vault that the refusals below must leave as it is. Made once. */
async function aNoteToProtect(): Promise<void> {
  if ((await owner.note("Refused/fine.md")).status === 200) return;
  bodyOf(await owner.save("Refused/fine.md", "fine\n"));
}

describe("paths that leave the vault", () => {
  it.each(OUTSIDE_THE_VAULT)("%s is refused with 400 on a save, and nothing is stored", async (path) => {
    // A save that is allowed, so a refusal here is the path's and not a route that is missing.
    await aNoteToProtect();

    expectRefusal(await owner.save(path, "never kept\n"), 400, `a save of ${path}`);

    const listed = bodyOf(await owner.list()).notes.map((n: { path: string }) => n.path);
    expect(listed).not.toContain(path);
    expect(listed).toContain("Refused/fine.md");
  });

  it.each(OUTSIDE_THE_VAULT)("%s is refused with 400 on a read, a history, a move and a delete", async (path) => {
    await aNoteToProtect();
    expectRefusal(await owner.note(path), 400, `a read of ${path}`);
    expectRefusal(await owner.history(path), 400, `a history of ${path}`);
    expectRefusal(await owner.move(path, "Refused/target.md"), 400, `a move from ${path}`);
    expectRefusal(await owner.move("Refused/fine.md", path), 400, `a move to ${path}`);
    expectRefusal(await owner.remove(path), 400, `a delete of ${path}`);
    // The note that was moved "to" outside the vault is still where it was, as it was.
    expect(bodyOf(await owner.note("Refused/fine.md"))).toMatchObject({ version: 1, text: "fine\n" });
  });

  it("an empty path is refused with 400 too", async () => {
    expectRefusal(await owner.save("", "no name\n"), 400, "a save with an empty path");
  });
});
