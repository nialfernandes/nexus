// The first sync of a vault brings the two sides together and deletes nothing. Notes only in Nexus come down, notes
// only in the vault go up, a note in both with the same text is left alone, and a note in both with different text is
// a clash: the vault's text is kept in a sibling note, Nexus's text is written into the note, and a notice says so.
// A vault has never synced when the plugin's stored cursor is null. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, makeDevice, nexusTexts, openWorld, type World } from "./world";

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

const CLASH_COPY = /^Both\/differs \(clash Test iPhone 2026-11-14[^)]*\)\.md$/;

describe("the first sync", () => {
  it("brings both sides together, keeps both texts of a clash, and deletes nothing", async () => {
    // What Nexus holds: two notes, and one that was made and then deleted.
    bodyOf(await world.agents.save("Both/same.md", "same\n"));
    bodyOf(await world.agents.save("Both/differs.md", "nexus text\n"));
    bodyOf(await world.agents.save("Nexus/only.md", "from nexus\n"));
    bodyOf(await world.agents.save("Old/gone.md", "was deleted in nexus\n"));
    bodyOf(await world.agents.remove("Old/gone.md"));

    const vaultFiles: Record<string, string> = {
      "Both/same.md": "same\n",
      "Both/differs.md": "vault text\n",
      "Vault/only.md": "from vault\n",
      "Old/gone.md": "was deleted in nexus\n",
      ".obsidian/app.json": "{}\n",
      "Attachments/pic.png": "not text",
    };
    const device = await makeDevice(world, { files: vaultFiles });
    await device.engine.sync();

    // The vault: everything it had is still there, the one clash became a copy, and Nexus's note came down.
    const after = device.vault.texts();
    const copies = Object.keys(after).filter((p) => CLASH_COPY.test(p));
    expect(copies, "one clash, one copy").toHaveLength(1);
    expect(after[copies[0]], "the copy holds the vault's text").toBe("vault text\n");
    delete after[copies[0]];
    expect(after).toEqual({
      "Both/same.md": "same\n",
      "Both/differs.md": "nexus text\n",
      "Nexus/only.md": "from nexus\n",
      "Vault/only.md": "from vault\n",
      "Old/gone.md": "was deleted in nexus\n",
      ".obsidian/app.json": "{}\n",
      "Attachments/pic.png": "not text",
    });
    const told = device.notices.filter((n) => n.includes("differs.md"));
    expect(told, "the clash is announced once").toHaveLength(1);
    expect(told[0], "naming the copy too").toContain(copies[0].split("/").pop()!);

    // Nexus: the note only the vault had went up, and the clash left Nexus's text as the note's text.
    const nexus = await nexusTexts(world);
    const extra = Object.keys(nexus).filter((p) => !["Both/same.md", "Both/differs.md", "Nexus/only.md", "Vault/only.md", "Old/gone.md"].includes(p));
    for (const path of extra) expect(path, "the only other note is the clash copy").toMatch(CLASH_COPY);
    expect(nexus["Both/same.md"]).toBe("same\n");
    expect(nexus["Both/differs.md"]).toBe("nexus text\n");
    expect(nexus["Nexus/only.md"]).toBe("from nexus\n");
    expect(nexus["Vault/only.md"]).toBe("from vault\n");
    expect(nexus["Old/gone.md"], "a note deleted in Nexus but still in the vault goes up again, not away").toBe("was deleted in nexus\n");
    expect(bodyOf(await world.owner.history("Both/same.md")).versions, "a note that was the same on both sides gets no new version").toHaveLength(1);

    // Nothing was deleted or moved, anywhere.
    expect(device.log.to("POST delete")).toEqual([]);
    expect(device.log.to("POST move")).toEqual([]);
    expect(device.log.timeline.filter((s) => s.kind === "remove" || s.kind === "rename")).toEqual([]);

    // What the plugin keeps: the version of every note that is in step, and a cursor to pull from next time.
    const data = device.data();
    expect(data.cursor, "the first sync leaves a cursor").not.toBeNull();
    expect(data.versions["Both/same.md"]).toBe(1);
    expect(data.versions["Nexus/only.md"]).toBe(1);
    expect(data.versions["Vault/only.md"]).toBe(1);
    expect(data.versions["Both/differs.md"], "the clash note stands on Nexus's version").toBe(1);
    expect(data.versions[".obsidian/app.json"]).toBeUndefined();
    expect(data.versions["Attachments/pic.png"]).toBeUndefined();
  });

  it("changes nothing when it is run again", async () => {
    bodyOf(await world.agents.save("Both/differs.md", "nexus text\n"));
    bodyOf(await world.agents.save("Nexus/only.md", "from nexus\n"));
    const device = await makeDevice(world, { files: { "Both/differs.md": "vault text\n", "Vault/only.md": "from vault\n" } });
    await device.engine.sync();
    const vaultAfterFirst = device.vault.texts();
    const nexusAfterFirst = await nexusTexts(world);

    await device.engine.sync();

    expect(device.vault.texts(), "the vault is as the first sync left it").toEqual(vaultAfterFirst);
    expect(await nexusTexts(world), "Nexus too: a clash copy stays in the vault it was made in and is never uploaded").toMatchObject(nexusAfterFirst);
    expect(device.notices.filter((n) => n.includes("differs.md")), "no second notice for the same clash").toHaveLength(1);
  });

  it("brings an empty vault everything Nexus holds, and an empty Nexus everything the vault holds", async () => {
    bodyOf(await world.agents.save("Notes/one.md", "1\n"));
    bodyOf(await world.agents.save("Notes/deep/two.md", "2\n"));
    const empty = await makeDevice(world, { files: {} });
    await empty.engine.sync();
    expect(empty.vault.texts()).toEqual({ "Notes/one.md": "1\n", "Notes/deep/two.md": "2\n" });

    await emptyNexus();
    const full = await makeDevice(world, { files: { "Mine/a.md": "a\n", "Mine/deep/b.md": "b\n" } });
    await full.engine.sync();
    expect(await nexusTexts(world)).toEqual({ "Mine/a.md": "a\n", "Mine/deep/b.md": "b\n" });
    expect(full.vault.texts()).toEqual({ "Mine/a.md": "a\n", "Mine/deep/b.md": "b\n" });
  });
});
