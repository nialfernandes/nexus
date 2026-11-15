// The library against the real server code: an agent that holds its own key reads, writes and deletes notes by path, in the format the
// plugin reads. Every call goes to the server's own routes (world.ts). The notes of "another writer" are made with the plugin world's
// own helpers, with the vault key, the way a device that holds it makes them.

import { beforeEach, describe, expect, it } from "vitest";
import { makeDevice, nexusNotes, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { AgentError, AgentVault } from "../src/index";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type World } from "./world";

let world: World;
let credentials: AgentCredentials;

beforeEach(async () => {
  world = await openWorld();
  await setUpVault(world);
  credentials = await agentCredentials(world);
});

const open = (extra: Partial<Parameters<typeof AgentVault.open>[0]> = {}) => {
  const { fetch, seen } = fetchOverNexus();
  return AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch, ...extra }).then((vault) => ({ vault, seen }));
};

describe("an agent with its own key", () => {
  it("opens the approval into the vault's id and key number, and holds nothing else it can show", async () => {
    const { vault } = await open();
    expect(vault.vaultId).toBe(world.keys.vaultId);
    expect(vault.kid).toBe(world.keys.kid);
    expect(JSON.stringify(vault), "nothing of the key is on the object").toBe("{}");
    expect(Object.getOwnPropertyNames(vault)).toEqual([]);
    vault.close();
  });

  it("writes a note by its path, reads it back, lists it, and the note is one the server holds as the plugin's format", async () => {
    const { vault } = await open();
    const written = await vault.write("Agent/2026-11-15 First.md", "# First\n\nThe agent's first note.\n");
    expect(written).toEqual({ path: "Agent/2026-11-15 First.md", version: 1, saved: true, merged: false, duplicate: false });
    expect(await vault.read("Agent/2026-11-15 First.md")).toBe("# First\n\nThe agent's first note.\n");
    expect(await vault.list()).toEqual(["Agent/2026-11-15 First.md"]);
    // What the server holds opens with the vault key, as the plugin opens it, and holds the path inside.
    expect(await nexusTexts(world)).toEqual({ "Agent/2026-11-15 First.md": "# First\n\nThe agent's first note.\n" });
    vault.close();
  });

  it("saves a second text as the next version of the same note, and does nothing for a text the note already has", async () => {
    const { vault, seen } = await open();
    await vault.write("a.md", "one\n");
    expect(await vault.write("a.md", "one\ntwo\n")).toMatchObject({ version: 2, saved: true });
    const before = seen.filter((s) => s.route === "save").length;
    expect(await vault.write("a.md", "one\ntwo\n")).toMatchObject({ version: 2, saved: false });
    expect(seen.filter((s) => s.route === "save").length, "no save was sent for the same text").toBe(before);
    const ids = Object.keys(await nexusNotes(world));
    expect(ids, "still one note").toHaveLength(1);
    vault.close();
  });

  it("reads a note another writer made, and sees what the plugin edits and deletes", async () => {
    const { vault } = await open();
    const made = await world.elsewhere.create("Ideas/shared.md", "from a device\n");
    expect(await vault.list()).toEqual(["Ideas/shared.md"]);
    expect(await vault.read("Ideas/shared.md")).toBe("from a device\n");
    await world.elsewhere.update(made.id, "Ideas/shared.md", "from a device, edited\n");
    expect(await vault.read("Ideas/shared.md")).toBe("from a device, edited\n");
    await world.elsewhere.update(made.id, "Ideas/renamed.md", "from a device, edited\n");
    expect(await vault.list(), "a rename inside the note moves it in the list").toEqual(["Ideas/renamed.md"]);
    await world.elsewhere.remove(made.id);
    expect(await vault.list()).toEqual([]);
    await expect(vault.read("Ideas/renamed.md")).rejects.toMatchObject({ code: "not-found" });
    vault.close();
  });

  it("deletes a note by its path, and the plugin sees it go", async () => {
    const { vault } = await open();
    await vault.write("Agent/gone.md", "soon gone\n");
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.textOf("Agent/gone.md")).toBe("soon gone\n");
    await vault.remove("Agent/gone.md");
    expect(await vault.list()).toEqual([]);
    await expect(vault.remove("Agent/gone.md")).rejects.toMatchObject({ code: "not-found" });
    await device.engine.sync();
    expect(device.vault.has("Agent/gone.md"), "the plugin removed it").toBe(false);
    vault.close();
  });

  it("writes where a note was deleted as a new note, and the old one stays deleted", async () => {
    const { vault } = await open();
    await vault.write("a.md", "first life\n");
    await vault.remove("a.md");
    expect(await vault.write("a.md", "second life\n")).toMatchObject({ saved: true, version: 1 });
    expect(await vault.read("a.md")).toBe("second life\n");
    vault.close();
  });

  it("is read by the plugin: a note the agent writes syncs into the plugin's vault with the same text, and the plugin's edit comes back", async () => {
    const { vault } = await open();
    await vault.write("Agent/note.md", "agent text\n");
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.textOf("Agent/note.md")).toBe("agent text\n");
    device.vault.type("Agent/note.md", "agent text\nplugin edit\n");
    await device.engine.push("Agent/note.md");
    expect(await vault.read("Agent/note.md")).toBe("agent text\nplugin edit\n");
    vault.close();
  });

  it("refuses a path the plugin would refuse, before anything is sent", async () => {
    const { vault, seen } = await open();
    const sentBefore = seen.length;
    for (const path of ["../outside.md", "/rooted.md", "a//b.md", "a/./b.md", ".obsidian/x.md", "Notes/.hidden.md", "a\\b.md", "a.txt", "", "Ideas/a (clash My iPhone 2026-11-14).md"]) {
      for (const call of [() => vault.write(path, "x"), () => vault.read(path), () => vault.remove(path)]) {
        await expect(call(), JSON.stringify(path)).rejects.toMatchObject({ name: "AgentError", code: "unsafe-path" });
      }
    }
    expect(seen.length, "no call to Nexus was made for any of them").toBe(sentBefore);
    expect(await nexusTexts(world)).toEqual({});
    vault.close();
  });

  it("leaves out a note it cannot open or whose path the plugin would refuse, and says how many", async () => {
    const { vault } = await open();
    await world.elsewhere.create("Good/one.md", "fine\n");
    const bad = await world.elsewhere.create("../escape.md", "a path the plugin refuses\n");
    expect(await vault.list()).toEqual(["Good/one.md"]);
    expect(vault.unreadableNotes()).toEqual([bad.id]);
    vault.close();
  });

  it("takes the note saved last when two notes share a path", async () => {
    const { vault } = await open();
    await world.elsewhere.create("Same/path.md", "first\n", "id-one");
    await world.elsewhere.create("Same/path.md", "second\n", "id-two");
    expect(await vault.list()).toEqual(["Same/path.md"]);
    expect(await vault.read("Same/path.md")).toBe("second\n");
    vault.close();
  });

  it("asks only for what changed since it last looked", async () => {
    const { vault, seen } = await open();
    await world.elsewhere.create("a.md", "a\n");
    await vault.list();
    const lookedAt = seen.length;
    await vault.list();
    const later = seen.slice(lookedAt);
    expect(later.map((s) => s.route.split("?")[0]), "one question, and it was the changes").toEqual(["changes"]);
    expect(later[0]!.route, "from the place it had reached").toMatch(/after=\d+/);
    vault.close();
  });

  it("runs calls one after another, so two writes at once both land", async () => {
    const { vault } = await open();
    await Promise.all([vault.write("a.md", "a\n"), vault.write("b.md", "b\n"), vault.write("c.md", "c\n")]);
    expect(await vault.list()).toEqual(["a.md", "b.md", "c.md"]);
    vault.close();
  });

  it("refuses every call after it is closed", async () => {
    const { vault } = await open();
    vault.close();
    vault.close();
    for (const call of [() => vault.list(), () => vault.read("a.md"), () => vault.write("a.md", "x"), () => vault.remove("a.md")]) {
      await expect(call()).rejects.toMatchObject({ name: "AgentError", code: "closed" });
    }
  });

  it("is an AgentError that carries a code, and takes the address with a slash at its end", async () => {
    const { vault } = await open({ address: `${ADDRESS}/` });
    await expect(vault.read("missing.md")).rejects.toBeInstanceOf(AgentError);
    vault.close();
  });
});
