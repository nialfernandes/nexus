// What happens when a change made in Nexus meets a note that has been edited here and not sent yet: the edit is never
// overwritten or deleted. And what a note's own move or delete looks like when it comes down: a rename, not a write and
// a removal. Against the in-memory Nexus (see world.ts).

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

describe("a note deleted in Nexus", () => {
  it("is removed here when it has no edits", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    bodyOf(await world.agents.remove("Ideas/a.md"));
    await device.engine.sync();

    expect(device.vault.texts()).toEqual({});
    expect(device.data().versions["Ideas/a.md"]).toBeUndefined();
    expect(device.log.to("POST save"), "and nothing is sent back").toEqual([]);
  });

  it("is kept here when it has edits that were never sent, and goes up again as a new note", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.vault.type("Ideas/a.md", "a, edited here\n");
    bodyOf(await world.agents.remove("Ideas/a.md"));
    await device.engine.sync();

    expect(device.vault.textOf("Ideas/a.md"), "the edit is still in the vault").toBe("a, edited here\n");
    expect(await nexusTexts(world), "and Nexus has it again").toEqual({ "Ideas/a.md": "a, edited here\n" });
    expect(device.data().versions["Ideas/a.md"]).toBe(3);
  });
});

describe("a note moved in Nexus", () => {
  it("is renamed here, with no write and no removal, when it has no edits", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    bodyOf(await world.agents.move("Ideas/a.md", "Moved/deep/a.md"));
    await device.engine.sync();

    expect(device.log.changesToVault()).toEqual([{ kind: "rename", path: "Ideas/a.md", to: "Moved/deep/a.md" }]);
    expect(device.vault.texts()).toEqual({ "Moved/deep/a.md": "a\n" });
    expect(device.data().versions).toEqual({ "Moved/deep/a.md": 2 });
  });

  it("leaves the edits made here where they are: the new name comes down and the old name goes up as its own note", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.vault.type("Ideas/a.md", "a, edited here\n");
    bodyOf(await world.agents.move("Ideas/a.md", "Moved/a.md"));
    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Ideas/a.md": "a, edited here\n", "Moved/a.md": "a\n" });
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "a, edited here\n", "Moved/a.md": "a\n" });
  });
});

describe("a note edited here and in Nexus", () => {
  it("is merged by Nexus when the edits do not touch the same lines, and nothing is announced", async () => {
    bodyOf(await world.agents.save("Ideas/m.md", "one\ntwo\nthree\n"));
    const device = await syncedDevice(world, { "Ideas/m.md": "one\ntwo\nthree\n" });
    device.vault.type("Ideas/m.md", "one\ntwo\nTHREE\n");
    bodyOf(await world.agents.save("Ideas/m.md", "ONE\ntwo\nthree\n", { base: 1 }));
    await device.engine.sync();

    expect(device.vault.textOf("Ideas/m.md")).toBe("ONE\ntwo\nTHREE\n");
    expect(await nexusTexts(world)).toEqual({ "Ideas/m.md": "ONE\ntwo\nTHREE\n" });
    expect(device.notices).toEqual([]);
  });
});

describe("a note made here that Nexus already holds, word for word", () => {
  it("is no clash: no copy, no notice, and the note stands on Nexus's version", async () => {
    bodyOf(await world.agents.save("Ideas/same.md", "same\n"));
    // A vault that has synced before, with a note in it the plugin has never seen: no version is stored, so no base is sent.
    const device = await makeDevice(world, { files: { "Ideas/same.md": "same\n" }, cursor: "0" });
    await device.engine.push("Ideas/same.md");

    expect(device.log.to("POST save")[0].status, "Nexus does answer a save with no base on a live note with a 409").toBe(409);
    expect(device.notices).toEqual([]);
    expect(device.vault.pathsStarting("Ideas/same (clash")).toEqual([]);
    expect(device.data().versions["Ideas/same.md"]).toBe(1);
  });
});
