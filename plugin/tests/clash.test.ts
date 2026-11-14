// A clash never loses anything. When two edits of a note touch the same line, the device cannot merge them: it keeps the
// vault's text in a sibling note named `<name> (clash <device> <date>).md`, writes Nexus's text into the note, stores
// Nexus's version for it and shows a notice that names both. The person merges by hand and deletes the copy. Nexus cannot read a note,
// so it is the device that finds the clash: it reads the note after Nexus refuses its save, and merges. Two notes made at one
// path on two devices clash the same way (the one with the smaller id keeps the path). Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, known, makeDevice, nexusNotes, openBlob, openWorld, sentNote, type Device, type World } from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The clash copies of a note in the vault: its name, then ` (clash `. */
const copiesOf = (device: Device, folderAndName: string): string[] => device.vault.pathsStarting(`${folderAndName} (clash `);

/** A note with three versions: an edit on another device changed the second line after the plugin saw version 2. */
async function noteMovedOnAfterVersionTwo(path: string): Promise<string> {
  const { id } = await world.elsewhere.create(path, "zero\n");
  await world.elsewhere.update(id, path, "one\ntwo\n");
  await world.elsewhere.update(id, path, "one\nREMOTE\n");
  return id;
}

/** A device whose vault holds `text` at `path`, last matched at version 2 of the note `id`. */
const deviceWith = (path: string, id: string, text: string, options: { name?: string } = {}) =>
  makeDevice(world, { ...options, files: { [path]: text, "Ideas/other.md": "untouched\n" }, notes: { [path]: known(path, "one\ntwo\n", 2, id) }, cursor: "0" });

describe("a refused save whose edits cannot be merged", () => {
  it("keeps the vault's text in a sibling note, writes Nexus's text to the note and says so in a notice", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/a.md");
    const device = await deviceWith("Ideas/a.md", id, "one\nLOCAL\n");

    await device.engine.push("Ideas/a.md");

    const saves = device.log.to("POST save");
    expect(saves, "the one save, and no second: there was nothing to send that was not already there").toHaveLength(1);
    expect(await sentNote(world, saves[0])).toMatchObject({ id, base: 2, path: "Ideas/a.md", text: "one\nLOCAL\n" });
    expect(saves[0].status, "the same line was changed on both sides").toBe(409);
    const copies = copiesOf(device, "Ideas/a");
    expect(copies, "one copy, named for the note, the device and the day").toHaveLength(1);
    expect(copies[0]).toMatch(/^Ideas\/a \(clash Test iPhone 2026-11-14[^)]*\)\.md$/);
    expect(device.vault.textOf(copies[0]), "the copy holds the vault's text").toBe("one\nLOCAL\n");
    expect(device.vault.textOf("Ideas/a.md"), "the note holds Nexus's text").toBe("one\nREMOTE\n");
    expect(device.data().notes["Ideas/a.md"], "the note now stands on Nexus's version").toMatchObject({ id, version: 3 });
    expect(device.vault.textOf("Ideas/other.md")).toBe("untouched\n");
    expect(device.notices, "one notice").toHaveLength(1);
    expect(device.notices[0], "it names the note").toContain("a.md");
    expect(device.notices[0], "and the copy").toContain(copies[0].split("/").pop()!);
  });

  it("leaves Nexus's own text as the note's latest version, and sends the vault's text nowhere: the copy stays on the device", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/kept.md");
    const device = await deviceWith("Ideas/kept.md", id, "one\nLOCAL\n");

    await device.engine.push("Ideas/kept.md");

    expect(await nexusNotes(world)).toEqual({ [id]: { path: "Ideas/kept.md", text: "one\nREMOTE\n", version: 3 } });
    const history = bodyOf(await world.owner.history(id)).versions as Array<{ version: number }>;
    expect(history.map((v) => v.version), "no version was added").toEqual([1, 2, 3]);
    for (const version of history) {
      const blob = bodyOf(await world.owner.note(id, version.version)).blob;
      expect((await openBlob(world.keys, id, blob)).text, `no version of the note holds the vault's text (version ${version.version})`).not.toContain("LOCAL");
    }
  });

  it("is not undone by the next pull: nothing comes back that changes the note or the copy", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/pulled.md");
    const device = await deviceWith("Ideas/pulled.md", id, "one\nLOCAL\n");
    await device.engine.push("Ideas/pulled.md");
    expect(copiesOf(device, "Ideas/pulled")).toHaveLength(1);
    const before = device.vault.texts();

    await device.engine.sync();

    expect(device.vault.texts(), "the vault is as the clash left it").toEqual(before);
    expect(device.data().notes["Ideas/pulled.md"]).toMatchObject({ id, version: 3 });
    expect(device.notices, "and the clash is not announced a second time").toHaveLength(1);
  });

  it("names the copy beside a note at the top of the vault without inventing a folder", async () => {
    const id = await noteMovedOnAfterVersionTwo("top.md");
    const device = await makeDevice(world, { files: { "top.md": "one\nLOCAL\n" }, notes: { "top.md": known("top.md", "one\ntwo\n", 2, id) }, cursor: "0" });

    await device.engine.push("top.md");

    const copies = copiesOf(device, "top");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^top \(clash Test iPhone 2026-11-14[^)]*\)\.md$/);
    expect(device.vault.textOf(copies[0])).toBe("one\nLOCAL\n");
  });

  it("never overwrites an earlier copy: a second clash on the same note, the same day, makes a second copy", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/twice.md");
    const device = await deviceWith("Ideas/twice.md", id, "one\nLOCAL\n");
    await device.engine.push("Ideas/twice.md");
    expect(device.vault.textOf("Ideas/twice.md")).toBe("one\nREMOTE\n");

    // The person keeps typing, and the other device moves the note on again: the same line, a second time.
    await world.elsewhere.update(id, "Ideas/twice.md", "one\nREMOTE AGAIN\n");
    device.vault.type("Ideas/twice.md", "one\nLOCAL AGAIN\n");
    await device.engine.push("Ideas/twice.md");

    const copies = copiesOf(device, "Ideas/twice");
    expect(copies, "two copies, not one written over").toHaveLength(2);
    expect(copies.map((p) => device.vault.textOf(p)).sort()).toEqual(["one\nLOCAL\n", "one\nLOCAL AGAIN\n"].sort());
    expect(device.vault.textOf("Ideas/twice.md")).toBe("one\nREMOTE AGAIN\n");
    expect(device.notices).toHaveLength(2);
  });

  it("writes a copy whose name is a legal file name even when the device's name is not one", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/legal.md");
    const device = await deviceWith("Ideas/legal.md", id, "one\nLOCAL\n", { name: "Mac/Studio: 2" });

    await device.engine.push("Ideas/legal.md");

    const copies = copiesOf(device, "Ideas/legal");
    expect(copies, "one copy, in the note's own folder").toHaveLength(1);
    const name = copies[0].slice("Ideas/".length);
    expect(name, "no slash, colon or other character a file name cannot hold").not.toMatch(/[\\/:*?"<>|]/);
    expect(device.vault.textOf(copies[0])).toBe("one\nLOCAL\n");
  });

  it("is not a clash when the other device made the same change: the note is matched, with no copy and no notice", async () => {
    const id = await noteMovedOnAfterVersionTwo("Ideas/agree.md");
    const device = await deviceWith("Ideas/agree.md", id, "one\nREMOTE\n");

    await device.engine.push("Ideas/agree.md");

    expect(copiesOf(device, "Ideas/agree")).toEqual([]);
    expect(device.notices).toEqual([]);
    expect(device.data().notes["Ideas/agree.md"]).toMatchObject({ id, version: 3 });
    expect(device.log.to("POST save"), "and one refused save is all that was sent").toHaveLength(1);
  });
});

describe("two notes made at one path on two devices", () => {
  const SMALL = "a".repeat(22);
  const LARGE = "z".repeat(22);
  const idMade = (id: string) => ({ id, version: 0, hash: "", savedPath: "" });

  it("keep the smaller id's note at the path, and the loser's device keeps its own text in a copy and deletes its own note", async () => {
    await world.elsewhere.create("Ideas/b.md", "from nexus\n", SMALL);
    const device = await makeDevice(world, { files: { "Ideas/b.md": "made here\n" }, cursor: "0", notes: { "Ideas/b.md": idMade(LARGE) } });
    await device.engine.push("Ideas/b.md");
    expect(device.log.to("POST save")[0].status, "the note went up, as a new note: no base").toBe(200);

    await device.engine.sync();

    const copies = copiesOf(device, "Ideas/b");
    expect(copies).toHaveLength(1);
    expect(device.vault.textOf(copies[0]), "the copy holds the text made here").toBe("made here\n");
    expect(device.vault.textOf("Ideas/b.md"), "the note holds the other note's text").toBe("from nexus\n");
    expect(device.data().notes["Ideas/b.md"]).toMatchObject({ id: SMALL, version: 1 });
    expect(device.notices).toHaveLength(1);
    expect(device.log.to("POST delete").map((c) => c.body), "this device's own note is deleted from Nexus").toEqual([{ id: LARGE, base: 1 }]);
    expect(Object.keys(await nexusNotes(world)), "one note is left").toEqual([SMALL]);

    // A second sync finds everything where the first left it: the deleted note's own versions in the feed bring nothing back.
    const before = { texts: device.vault.texts(), notices: [...device.notices], notes: structuredClone(device.data().notes) };
    await device.engine.sync();
    expect(device.vault.texts()).toEqual(before.texts);
    expect(device.notices).toEqual(before.notices);
    expect(device.data().notes).toEqual(before.notes);
    expect(device.log.to("POST save"), "and nothing more was sent").toHaveLength(1);
  });

  it("leave the path to this device's note when its id is the smaller, and the other note is left for its own device to remove", async () => {
    await world.elsewhere.create("Ideas/b.md", "from nexus\n", LARGE);
    const device = await makeDevice(world, { files: { "Ideas/b.md": "made here\n" }, cursor: "0", notes: { "Ideas/b.md": idMade(SMALL) } });
    await device.engine.push("Ideas/b.md");

    await device.engine.sync();

    expect(copiesOf(device, "Ideas/b")).toEqual([]);
    expect(device.vault.textOf("Ideas/b.md")).toBe("made here\n");
    expect(device.notices).toEqual([]);
    expect(device.log.to("POST delete"), "this device deletes nothing that is not its own").toEqual([]);
  });
});
