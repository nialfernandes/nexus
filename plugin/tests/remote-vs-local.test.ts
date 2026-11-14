// What happens when a change made in Nexus meets a note that has been edited here and not sent yet: the edit is never
// overwritten or deleted. And what a note's own rename or delete looks like when it comes down: a rename, not a write and
// a removal. And two notes made at one path on two devices, which are two ids in Nexus: the one with the smaller id keeps the
// path, on every device, and nothing is lost on either. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

/** Two note ids, and which one keeps a path both are made at: the smaller. */
const SMALL = "a".repeat(22);
const LARGE = "z".repeat(22);
/** What a device holds for a note it has chosen an id for and not yet saved. */
const idMade = (id: string) => ({ id, version: 0, hash: "", savedPath: "" });

describe("a note deleted in Nexus", () => {
  it("is removed here when it has no edits", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    await world.elsewhere.remove(device.data().notes["Ideas/a.md"].id);

    await device.engine.sync();

    expect(device.vault.texts()).toEqual({});
    expect(device.data().notes["Ideas/a.md"]).toBeUndefined();
    expect(device.log.to("POST save"), "and nothing is sent back").toEqual([]);
  });

  it("is kept here when it has edits that were never sent, and goes up again as a new note", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    const old = device.data().notes["Ideas/a.md"].id;
    device.vault.type("Ideas/a.md", "a, edited here\n");
    await world.elsewhere.remove(old);

    await device.engine.sync();

    expect(device.vault.textOf("Ideas/a.md"), "the edit is still in the vault").toBe("a, edited here\n");
    expect(await nexusTexts(world), "and Nexus has it again").toEqual({ "Ideas/a.md": "a, edited here\n" });
    expect(device.data().notes["Ideas/a.md"], "as a new note, with an id of its own").toMatchObject({ version: 1 });
    expect(device.data().notes["Ideas/a.md"].id).not.toBe(old);
  });
});

describe("a note moved in Nexus", () => {
  it("is renamed here, with no write and no removal, when it has no edits", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    await world.elsewhere.update(id, "Moved/deep/a.md", "a\n");

    await device.engine.sync();

    expect(device.log.changesToVault()).toEqual([{ kind: "rename", path: "Ideas/a.md", to: "Moved/deep/a.md" }]);
    expect(device.vault.texts()).toEqual({ "Moved/deep/a.md": "a\n" });
    expect(Object.entries(device.data().notes)).toEqual([["Moved/deep/a.md", expect.objectContaining({ id, version: 2, savedPath: "Moved/deep/a.md" })]]);
  });

  it("follows the move with the edits made here: the note is renamed and the edit is sent under the new name", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    device.vault.type("Ideas/a.md", "a, edited here\n");
    await world.elsewhere.update(id, "Moved/a.md", "a\n");

    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Moved/a.md": "a, edited here\n" });
    expect(await nexusTexts(world)).toEqual({ "Moved/a.md": "a, edited here\n" });
    expect(device.notices).toEqual([]);
  });
});

describe("a note edited here and in Nexus", () => {
  it("is merged on the device when the edits do not touch the same lines, and nothing is announced", async () => {
    const note = await world.elsewhere.create("Ideas/m.md", "one\ntwo\nthree\n");
    const device = await syncedDevice(world, { "Ideas/m.md": "one\ntwo\nthree\n" });
    device.vault.type("Ideas/m.md", "one\ntwo\nTHREE\n");
    await world.elsewhere.update(note.id, "Ideas/m.md", "ONE\ntwo\nthree\n");

    await device.engine.sync();

    expect(device.vault.textOf("Ideas/m.md")).toBe("ONE\ntwo\nTHREE\n");
    expect(await nexusTexts(world)).toEqual({ "Ideas/m.md": "ONE\ntwo\nTHREE\n" });
    expect(device.notices).toEqual([]);
  });
});

describe("a note made here that Nexus already holds, word for word", () => {
  it("is no clash when the other note's id is smaller: no copy, no notice, and this device's note goes, leaving one", async () => {
    await world.elsewhere.create("Ideas/same.md", "same\n", SMALL);
    // A vault that has synced before, with a note in it the plugin has never seen: it makes its own id for it and sends it.
    const device = await makeDevice(world, { files: { "Ideas/same.md": "same\n" }, cursor: "0", notes: { "Ideas/same.md": idMade(LARGE) } });
    await device.engine.push("Ideas/same.md");
    expect(device.log.to("POST save")[0].status, "Nexus takes it: a note under a new id is a new note").toBe(200);
    expect(bodyOf(await world.owner.list()).notes, "so for now Nexus holds the text twice").toHaveLength(2);

    await device.engine.sync();

    expect(device.notices).toEqual([]);
    expect(device.vault.pathsStarting("Ideas/same (clash")).toEqual([]);
    expect(device.data().notes["Ideas/same.md"], "the note stands on the other note").toMatchObject({ id: SMALL, version: 1 });
    expect(device.log.to("POST delete").map((c) => c.body), "and this device's own copy of the note is deleted").toEqual([{ id: LARGE, base: 1 }]);
    expect(bodyOf(await world.owner.list()).notes.map((n: { id: string }) => n.id), "one note is left in Nexus").toEqual([SMALL]);
    expect(device.vault.texts()).toEqual({ "Ideas/same.md": "same\n" });
  });

  it("is left alone when this device's note has the smaller id: the other device's note is the one that goes", async () => {
    await world.elsewhere.create("Ideas/same.md", "same\n", LARGE);
    const device = await makeDevice(world, { files: { "Ideas/same.md": "same\n" }, cursor: "0", notes: { "Ideas/same.md": idMade(SMALL) } });
    await device.engine.push("Ideas/same.md");

    await device.engine.sync();

    expect(device.notices).toEqual([]);
    expect(device.data().notes["Ideas/same.md"]).toMatchObject({ id: SMALL, version: 1 });
    expect(device.log.to("POST delete"), "this device deletes nothing: the other note's own device does").toEqual([]);
    expect(device.vault.texts()).toEqual({ "Ideas/same.md": "same\n" });
  });
});
