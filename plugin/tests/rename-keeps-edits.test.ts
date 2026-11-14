// A rename sent to Nexus must not cost an edit on either side. A rename is a new version of the same note (the path is inside the
// encrypted record, the id stays), so it is sent from the version the plugin last matched: if another device's edit landed first,
// Nexus refuses, and this device merges the edit and the rename on the device. An edit made here within the pause before it would
// have gone up is not left behind when the note is renamed. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_PAUSE, emptyNexus, fakeTimers, forbidFetch, nexusNotes, nexusTexts, openWorld, quiet, syncedDevice, type World } from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a rename sent after another device's edit landed", () => {
  it("keeps that edit: the rename is merged with it on the device, under the same id", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "one\ntwo\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    await world.elsewhere.update(id, "Ideas/a.md", "one\nTWO elsewhere\n");

    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");

    expect(device.vault.textOf("Ideas/b.md"), "the other device's edit is in the renamed note").toBe("one\nTWO elsewhere\n");
    expect(device.data().notes["Ideas/b.md"]).toMatchObject({ id, version: 3, savedPath: "Ideas/b.md" });
    expect(await nexusNotes(world)).toEqual({ [id]: { path: "Ideas/b.md", text: "one\nTWO elsewhere\n", version: 3 } });
    expect(device.notices).toEqual([]);
  });

  it("meets an edit made here before the rename: the two edits and the rename are merged", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "one\ntwo\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    await world.elsewhere.update(id, "Ideas/a.md", "one\nTWO elsewhere\n");
    device.vault.type("Ideas/a.md", "ONE here\ntwo\n");

    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");
    await device.engine.sync();

    expect(device.vault.textOf("Ideas/b.md")).toBe("ONE here\nTWO elsewhere\n");
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "ONE here\nTWO elsewhere\n" });
    expect(device.notices).toEqual([]);
  });

  it("is followed by the other device, which renames its file and keeps its id", async () => {
    const a = await syncedDevice(world, { "Ideas/a.md": "same\n" });
    const b = await syncedDevice(world, {});
    await b.engine.sync();
    expect(b.vault.texts()).toEqual({ "Ideas/a.md": "same\n" });

    await a.vault.rename("Ideas/a.md", "Moved/b.md");
    await a.engine.renamed("Ideas/a.md", "Moved/b.md");
    await b.engine.sync();

    expect(b.vault.texts(), "device B's file moved, with no copy left behind").toEqual({ "Moved/b.md": "same\n" });
    expect(b.data().notes["Moved/b.md"].id).toBe(a.data().notes["Moved/b.md"].id);
    expect(b.log.to("POST save"), "following a rename sends nothing back").toEqual([]);
  });
});

describe("a rename within the pause after an edit", () => {
  it("keeps the edit: it goes up under the new name", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "before\n" });
    fakeTimers();

    device.vault.type("Ideas/a.md", "edited just before the rename\n");
    device.engine.edited("Ideas/a.md");
    await vi.advanceTimersByTimeAsync(1000);
    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);
    await quiet(device.log);

    expect(await nexusTexts(world), "the new name holds the edit, not the text from before it").toEqual({
      "Ideas/b.md": "edited just before the rename\n",
    });
    expect(device.vault.texts()).toEqual({ "Ideas/b.md": "edited just before the rename\n" });
  });
});
