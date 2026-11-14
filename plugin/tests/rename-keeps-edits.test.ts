// A rename sent to Nexus must not cost an edit on either side. An edit another device made before the move landed still
// comes down, and an edit made here within the pause before it would have gone up is not left behind when the note is
// renamed. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_PAUSE, bodyOf, emptyNexus, fakeTimers, forbidFetch, nexusTexts, openWorld, quiet, syncedDevice, type World } from "./world";

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
  it("does not claim that edit as seen: it comes down on the next pull", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "one\ntwo\n" });
    bodyOf(await world.agents.save("Ideas/a.md", "one\nTWO elsewhere\n", { base: 1 }));

    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");
    expect(device.data().versions["Ideas/b.md"], "version 2 is not here yet, so the note still stands on version 1").toBe(1);

    await device.engine.sync();

    expect(device.vault.textOf("Ideas/b.md"), "the other device's edit is in the renamed note").toBe("one\nTWO elsewhere\n");
    expect(device.data().versions["Ideas/b.md"]).toBe(3);
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "one\nTWO elsewhere\n" });
  });

  it("meets an edit made here before the rename: Nexus merges the two", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "one\ntwo\n" });
    bodyOf(await world.agents.save("Ideas/a.md", "one\nTWO elsewhere\n", { base: 1 }));
    device.vault.type("Ideas/a.md", "ONE here\ntwo\n");

    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");
    await device.engine.sync();

    expect(device.vault.textOf("Ideas/b.md")).toBe("ONE here\nTWO elsewhere\n");
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "ONE here\nTWO elsewhere\n" });
    expect(device.notices).toEqual([]);
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
