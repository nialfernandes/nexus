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
    device.network.online = false;
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");

    expect(device.engine.status()).toMatch(/offline/i);
    expect(await nexusTexts(world), "Nexus has not been told yet").toEqual({ "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    expect(device.data().pendingDeletes, "the delete is kept in the plugin's data, so a restart does not lose it").toEqual(["Ideas/a.md"]);

    const restarted = await makeDevice(world, { vault: device.vault, from: device.data() });
    await restarted.engine.sync();

    expect(restarted.log.to("POST delete").map((c) => c.body)).toEqual([{ path: "Ideas/a.md" }]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "b\n" });
    expect(restarted.data().pendingDeletes).toEqual([]);
  });

  it("is not sent when the note is back in the vault by then", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.network.online = false;
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");
    device.vault.type("Ideas/a.md", "a\n"); // made again, with the same text

    device.network.online = true;
    await device.engine.sync();

    expect(device.log.to("POST delete"), "a note that is there is not deleted").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "a\n" });
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
  it("deletes the old name later and sends the new name as a note", async () => {
    const device = await syncedDevice(world, { "Ideas/old.md": "text\n" });
    device.network.online = false;
    await device.vault.rename("Ideas/old.md", "Ideas/new.md");
    await device.engine.renamed("Ideas/old.md", "Ideas/new.md");
    expect(await nexusTexts(world)).toEqual({ "Ideas/old.md": "text\n" });

    device.network.online = true;
    await device.engine.sync();

    expect(await nexusTexts(world), "nothing is lost: the text is under the new name, and the old name is gone").toEqual({ "Ideas/new.md": "text\n" });
    expect(device.vault.texts()).toEqual({ "Ideas/new.md": "text\n" });
  });
});

describe("a note missing from the vault when Obsidian starts", () => {
  it("is never deleted from Nexus, and comes back into the vault when it next changes there", async () => {
    const before = await syncedDevice(world, { "Ideas/kept.md": "kept\n", "Ideas/other.md": "other\n" });
    // Deleted while Obsidian was closed: no event was ever seen.
    await before.vault.remove("Ideas/kept.md");

    const reopened = await makeDevice(world, { vault: before.vault, from: before.data() });
    await reopened.engine.sync();
    expect(reopened.log.to("POST delete"), "no delete is sent for a note that is merely missing").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/kept.md": "kept\n", "Ideas/other.md": "other\n" });

    bodyOf(await world.agents.save("Ideas/kept.md", "kept, edited elsewhere\n", { base: 1 }));
    await reopened.engine.sync();
    expect(reopened.vault.textOf("Ideas/kept.md"), "a change made in Nexus puts the note back").toBe("kept, edited elsewhere\n");
  });
});
