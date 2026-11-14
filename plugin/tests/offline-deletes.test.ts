// A delete or a rename the plugin sees while Nexus cannot be reached (offline, or signed out) is kept and sent when it
// can be, and a note that is only missing from the vault when Obsidian starts is never deleted from Nexus. Against the
// in-memory Nexus (see world.ts).

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

describe("a delete made while Nexus cannot be reached", () => {
  it("is kept, and sent on the next sync once Nexus can be reached", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    const gone = { id: device.data().notes["Ideas/a.md"].id };
    device.network.online = false;
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");

    expect(device.engine.status()).toMatch(/offline/i);
    expect(await nexusTexts(world), "Nexus has not been told yet").toEqual({ "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    expect(device.data().pendingDeletes, "the delete is kept in the plugin's data, so a restart does not lose it").toEqual([
      expect.objectContaining({ id: gone.id, version: 1 }),
    ]);

    const restarted = await makeDevice(world, { vault: device.vault, from: device.data(), unlock: device.unlock });
    await restarted.engine.sync();

    expect(restarted.log.to("POST delete").map((c) => c.body), "Nexus is told by the note's id and the version it was at").toEqual([{ id: gone.id, base: 1 }]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "b\n" });
    expect(restarted.data().pendingDeletes).toEqual([]);
  });

  it("is not sent when the note is back in the vault by then", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    const { id } = device.data().notes["Ideas/a.md"];
    device.network.online = false;
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");
    device.vault.type("Ideas/a.md", "a\n"); // made again, with the same text

    device.network.online = true;
    await device.engine.sync();

    expect(device.log.to("POST delete"), "a note that is there is not deleted").toEqual([]);
    expect(device.log.to("POST save"), "and is not made again either: it is the same note").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "a\n" });
    expect(device.data().notes["Ideas/a.md"], "with the id it had").toMatchObject({ id, version: 1 });
    expect(device.data().pendingDeletes).toEqual([]);
    expect(device.notices, "and the same text on both sides is no clash").toEqual([]);
  });

  it("is sent once the person signs in again, when it was made signed out", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.deps.data.token = null;
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");
    expect(device.log.to("POST delete"), "nothing is sent signed out").toEqual([]);

    device.deps.data.token = world.token;
    await device.engine.sync();
    expect(await nexusTexts(world)).toEqual({});
  });
});

describe("a rename made while Nexus cannot be reached", () => {
  it("is sent later as a new version of the same note, with the new path inside it and the same id", async () => {
    const device = await syncedDevice(world, { "Ideas/old.md": "text\n" });
    const { id } = device.data().notes["Ideas/old.md"];
    device.network.online = false;
    await device.vault.rename("Ideas/old.md", "Ideas/new.md");
    await device.engine.renamed("Ideas/old.md", "Ideas/new.md");
    expect(await nexusTexts(world)).toEqual({ "Ideas/old.md": "text\n" });
    expect(device.data().notes["Ideas/new.md"], "the note is known under its new path, with its id and what Nexus has").toMatchObject({ id, version: 1, savedPath: "Ideas/old.md" });
    expect(device.data().notes["Ideas/old.md"]).toBeUndefined();

    device.network.online = true;
    await device.engine.sync();
    expect(await nexusTexts(world), "nothing is lost: the text is under the new name, and the old name is gone").toEqual({ "Ideas/new.md": "text\n" });
    expect((bodyOf(await world.owner.list()).notes as Array<{ id: string }>).map((n) => n.id), "one note, not two: a rename is not a delete and a new note").toEqual([id]);
    expect(device.log.to("POST delete")).toEqual([]);
    expect(device.vault.texts()).toEqual({ "Ideas/new.md": "text\n" });
  });
});

describe("a note missing from the vault when Obsidian starts", () => {
  it("is never deleted from Nexus, and comes back into the vault when it next changes there", async () => {
    const before = await syncedDevice(world, { "Ideas/kept.md": "kept\n", "Ideas/other.md": "other\n" });
    // Deleted while Obsidian was closed: no event was ever seen.
    await before.vault.remove("Ideas/kept.md");

    const reopened = await makeDevice(world, { vault: before.vault, from: before.data(), unlock: before.unlock });
    await reopened.engine.sync();
    expect(reopened.log.to("POST delete"), "no delete is sent for a note that is merely missing").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/kept.md": "kept\n", "Ideas/other.md": "other\n" });

    await world.elsewhere.update(before.data().notes["Ideas/kept.md"].id, "Ideas/kept.md", "kept, edited elsewhere\n");
    await reopened.engine.sync();
    expect(reopened.vault.textOf("Ideas/kept.md"), "a change made in Nexus puts the note back").toBe("kept, edited elsewhere\n");
  });
});
