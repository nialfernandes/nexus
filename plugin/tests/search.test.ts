// Search is done on the device. The server holds only blobs and has no search, so the plugin keeps a small index of the vault's own
// words, in memory, and asks nobody. The index follows what happens to the vault (an edit, a note that comes down, a rename, a
// delete), works with no key unlocked and with no network, and is never written anywhere.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchIndex } from "../src/search";
import { askNexus, EDIT_PAUSE, emptyNexus, fakeTimers, forbidFetch, makeDevice, openWorld, syncedDevice, type World } from "./world";

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

describe("the index", () => {
  const index = () => {
    const found = createSearchIndex();
    found.set("Projects/Garden plan.md", "Beds along the south fence.\nBuy seed potatoes in March.\nCompost corner by the gate.\n");
    found.set("Ideas/Podcast names.md", "Three possible names: Slow Radio, Small Hours, Night Shelf.\nCafé ✨ 日本語\n");
    found.set("Daily/2026-11-15.md", "Garden: potatoes ordered.\n");
    return found;
  };

  it("finds the notes that use each word, in any case, and starts a word from its first letters", () => {
    const found = index();
    expect(found.search("potatoes").map((h) => h.path).sort()).toEqual(["Daily/2026-11-15.md", "Projects/Garden plan.md"]);
    expect(found.search("POTAT").map((h) => h.path).sort(), "a word is found from its first letters, in any case").toEqual(["Daily/2026-11-15.md", "Projects/Garden plan.md"]);
    expect(found.search("compost")).toEqual([{ path: "Projects/Garden plan.md", snippet: "Compost corner by the gate." }]);
  });

  it("wants every word searched for: each is the start of some word in the note or in its name", () => {
    const found = index();
    expect(found.search("potatoes march").map((h) => h.path)).toEqual(["Projects/Garden plan.md"]);
    expect(found.search("potatoes radio")).toEqual([]);
    expect(found.search("   ")).toEqual([]);
    expect(found.search("nothing here")).toEqual([]);
  });

  it("looks past accents and finds words in any script", () => {
    const found = index();
    expect(found.search("cafe").map((h) => h.path)).toEqual(["Ideas/Podcast names.md"]);
    expect(found.search("日本語").map((h) => h.path)).toEqual(["Ideas/Podcast names.md"]);
  });

  it("puts the notes whose name matches first, then the ones that use the words most", () => {
    const found = createSearchIndex();
    found.set("Notes/one.md", "garden garden garden garden\n");
    found.set("Notes/Garden.md", "just a title\n");
    found.set("Notes/two.md", "garden\n");
    expect(found.search("garden").map((h) => h.path)).toEqual(["Notes/Garden.md", "Notes/one.md", "Notes/two.md"]);
    expect(found.search("garden", 2), "and stops at the limit").toHaveLength(2);
  });

  it("follows a note that is renamed, changed and removed", () => {
    const found = index();
    found.rename("Daily/2026-11-15.md", "Archive/old day.md");
    expect(found.search("potatoes").map((h) => h.path).sort()).toEqual(["Archive/old day.md", "Projects/Garden plan.md"]);
    expect(found.search("old day").map((h) => h.path), "its new name is searched").toEqual(["Archive/old day.md"]);
    found.set("Projects/Garden plan.md", "Nothing about vegetables any more.\n");
    expect(found.search("potatoes").map((h) => h.path)).toEqual(["Archive/old day.md"]);
    found.remove("Archive/old day.md");
    expect(found.search("potatoes")).toEqual([]);
    expect(found.paths().sort()).toEqual(["Ideas/Podcast names.md", "Projects/Garden plan.md"]);
  });
});

describe("the engine's search", () => {
  const FILES = { "Projects/Garden plan.md": "Buy seed potatoes in March.\n", "Ideas/Podcast names.md": "Slow Radio\n" };

  it("finds what is in the vault without asking Nexus anything, with no key and no network", async () => {
    const device = await makeDevice(world, { files: FILES, unlock: null });
    device.network.online = false;
    await device.engine.cameToFront();
    const before = device.log.requests().length;

    expect(device.engine.search("potatoes").map((h) => h.path)).toEqual(["Projects/Garden plan.md"]);
    expect(device.engine.search("radio").map((h) => h.path)).toEqual(["Ideas/Podcast names.md"]);

    expect(device.log.requests().length, "nothing was asked of Nexus").toBe(before);
    expect(device.engine.status(), "the vault is still locked").toMatch(/locked/i);
  });

  it("finds a note that comes down, a note that is edited, a rename and a delete", async () => {
    const device = await syncedDevice(world, FILES);
    await device.engine.cameToFront();
    await world.elsewhere.create("Inbox/From elsewhere.md", "quince jelly\n");
    await device.engine.sync();
    expect(device.engine.search("quince").map((h) => h.path), "a note that came down").toEqual(["Inbox/From elsewhere.md"]);

    fakeTimers();
    device.vault.type("Ideas/Podcast names.md", "Slow Radio and Lantern Hour\n");
    device.engine.edited("Ideas/Podcast names.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(device.engine.search("lantern").map((h) => h.path), "a note that was edited").toEqual(["Ideas/Podcast names.md"]));

    await device.vault.rename("Ideas/Podcast names.md", "Ideas/Show names.md");
    await device.engine.renamed("Ideas/Podcast names.md", "Ideas/Show names.md");
    expect(device.engine.search("lantern").map((h) => h.path), "a rename").toEqual(["Ideas/Show names.md"]);

    await device.vault.remove("Ideas/Show names.md");
    await device.engine.deleted("Ideas/Show names.md");
    expect(device.engine.search("lantern"), "a delete").toEqual([]);
  });

  it("does not search what is not a note: a file in .obsidian, an attachment, a clash copy", async () => {
    const device = await makeDevice(world, {
      files: { "Ideas/a.md": "walnut\n", ".obsidian/app.json": "walnut\n", "Attachments/x.png": "walnut", "Ideas/a (clash Test iPhone 2026-11-14).md": "walnut\n" },
      unlock: null,
    });
    await device.engine.cameToFront();
    expect(device.engine.search("walnut").map((h) => h.path)).toEqual(["Ideas/a.md"]);
  });

  it("is not something the server can do: it has no search route any more", async () => {
    const answer = await askNexus("GET", "search?q=potatoes", { cookie: world.ownerCookie });
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: "Nexus has no such route." });
  });
});
