// A note made again at a path the other writer moved away from is a different note: its versions start over. It must
// come down (or clash), never be skipped because the old note's version was higher, and a local note must never
// overwrite it. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

/** The other writer moves Ideas/a.md to Ideas/b.md and makes a brand new note at Ideas/a.md (its version 1). */
async function moveAwayAndMakeAgain(): Promise<void> {
  bodyOf(await world.agents.move("Ideas/a.md", "Ideas/b.md"));
  bodyOf(await world.agents.save("Ideas/a.md", "brand new\n"));
}

describe("a note made again at a path that was moved away from", () => {
  it("comes down over an unedited copy, though the old note's stored version is higher", async () => {
    // Three versions, so the old note's stored version is higher than the new note's first.
    bodyOf(await world.agents.save("Ideas/a.md", "old\n"));
    bodyOf(await world.agents.save("Ideas/a.md", "old, again\n", { base: 1 }));
    bodyOf(await world.agents.save("Ideas/a.md", "old, once more\n", { base: 2 }));
    const device = await syncedDevice(world, { "Ideas/a.md": "old, once more\n" });
    // A note of my own at b.md, not sent yet: the unedited a.md cannot simply be renamed to it.
    device.vault.type("Ideas/b.md", "I was here first\n");
    await moveAwayAndMakeAgain();
    await device.engine.sync();

    expect(device.vault.textOf("Ideas/a.md"), "the new note came down").toBe("brand new\n");
    expect(device.data().versions["Ideas/a.md"], "and stands on its own version, not the old note's").toBe(1);
    expect(await nexusTexts(world)).toMatchObject({ "Ideas/a.md": "brand new\n" });
  });

  it("comes down beside an edited copy, which is kept in a clash copy and never sent over the new note", async () => {
    bodyOf(await world.agents.save("Ideas/a.md", "old\n"));
    bodyOf(await world.agents.save("Ideas/a.md", "old, again\n", { base: 1 }));
    const device = await syncedDevice(world, { "Ideas/a.md": "old, again\n" });
    device.vault.type("Ideas/a.md", "old, again, edited here\n"); // not sent yet
    await moveAwayAndMakeAgain();

    await device.engine.sync();

    const copies = device.vault.pathsStarting("Ideas/a (clash ");
    expect(copies, "one clash copy").toHaveLength(1);
    expect(device.vault.textOf(copies[0]), "it holds the edit made here").toBe("old, again, edited here\n");
    expect(device.vault.textOf("Ideas/a.md"), "the note holds the new note's text").toBe("brand new\n");
    expect(device.vault.textOf("Ideas/b.md"), "the moved note came down too").toBe("old, again\n");
    expect(device.notices, "and a notice names both").toHaveLength(1);
    expect(await nexusTexts(world), "Nexus's new note was not overwritten").toEqual({ "Ideas/a.md": "brand new\n", "Ideas/b.md": "old, again\n" });
  });

  it("is not mistaken for another writer's when this plugin made it itself and has edited it since", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "old\n" });
    // This device moves the note away and makes a new one at the old path, sends it, and goes on typing.
    await device.vault.rename("Ideas/a.md", "Ideas/b.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/b.md");
    device.vault.type("Ideas/a.md", "new here\n");
    await device.engine.push("Ideas/a.md");
    device.vault.type("Ideas/a.md", "new here, and more\n");

    await device.engine.sync();

    expect(device.notices, "its own note coming back in the feed is no clash").toEqual([]);
    expect(device.vault.pathsStarting("Ideas/a (clash ")).toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "new here, and more\n", "Ideas/b.md": "old\n" });
  });
});
