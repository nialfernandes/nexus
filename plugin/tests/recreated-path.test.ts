// A note moved away from a path and another note made at the old path are two notes with two ids. Both have to come down
// to the right places, whichever the changes feed lists first, and a device's unsent edit of the moved note must not be lost or
// sent over the new one. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyNexus, forbidFetch, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

describe("a note made again at a path that was moved away from", () => {
  it("comes down in its own place beside the moved note, whichever the feed lists first", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "old\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    // The new note is saved first, then the old one is moved: the feed lists the new note before the move that makes room for it.
    const fresh = await world.elsewhere.create("Ideas/a.md", "brand new\n");
    await world.elsewhere.update(id, "Ideas/b.md", "old\n");

    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Ideas/a.md": "brand new\n", "Ideas/b.md": "old\n" });
    expect(device.data().notes["Ideas/a.md"]).toMatchObject({ id: fresh.id, version: 1 });
    expect(device.data().notes["Ideas/b.md"]).toMatchObject({ id, version: 2 });
    expect(device.notices, "nothing to say: nothing was in conflict").toEqual([]);
    expect(device.engine.status()).toMatch(/last synced/i);
    expect(device.log.to("POST save"), "and nothing was sent back").toEqual([]);
  });

  it("waits for an edited note to move: the edit is merged and follows the move, and the new note takes the old path", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "old, again\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    device.vault.type("Ideas/a.md", "old, again, edited here\n"); // not sent yet
    await world.elsewhere.update(id, "Ideas/b.md", "old, again\n");
    const fresh = await world.elsewhere.create("Ideas/a.md", "brand new\n");

    await device.engine.sync();

    expect(device.vault.pathsStarting("Ideas/a (clash "), "no copy: nothing was lost, so nothing needed keeping").toEqual([]);
    expect(device.vault.texts()).toEqual({ "Ideas/a.md": "brand new\n", "Ideas/b.md": "old, again, edited here\n" });
    expect(device.data().notes["Ideas/a.md"]).toMatchObject({ id: fresh.id });
    expect(device.data().notes["Ideas/b.md"]).toMatchObject({ id });
    expect(await nexusTexts(world), "Nexus's new note was not overwritten, and the edit went up under the new name").toEqual({
      "Ideas/a.md": "brand new\n",
      "Ideas/b.md": "old, again, edited here\n",
    });
    expect(device.notices).toEqual([]);
  });

  it("is kept beside a note that stays at the path, as a copy that is never sent, and nothing is lost", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "mine\n" });
    // Another note is made at the path this device's note still holds: two notes in Nexus with one path.
    await world.elsewhere.create("Ideas/a.md", "the other note\n");

    await device.engine.sync();

    const copies = device.vault.pathsStarting("Ideas/a (clash ");
    expect(copies, "one copy").toHaveLength(1);
    expect(device.vault.textOf(copies[0])).toBe("the other note\n");
    expect(device.vault.textOf("Ideas/a.md")).toBe("mine\n");
    expect(device.notices, "and a notice names it").toHaveLength(1);
    expect(device.log.to("POST save"), "the copy is not sent").toEqual([]);
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
