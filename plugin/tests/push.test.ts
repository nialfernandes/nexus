// A local edit goes up to Nexus as an encrypted blob, with the version the plugin last saw as its base. When Nexus refuses because
// the note has moved on, the device reads the note as it is now, merges the two edits on the device, and saves again. Against the
// in-memory Nexus (see world.ts for the contract and where each piece comes from).
//
// The worked example: Ideas/a.md is at stored version 2, the vault's text is `one\nTWO\n`, and Nexus has moved on to version 3
// (`ONE\ntwo\n`). The plugin sends one save with base 2 and Nexus refuses it. The plugin reads version 3, and version 2 (what it
// started from), merges the three on the device into `ONE\nTWO\n`, writes that to the note, and saves again with base 3, which
// becomes version 4.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, known, makeDevice, nexusTexts, openWorld, sentNote, syncedDevice, type World } from "./world";

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

describe("a local edit goes up", () => {
  it("is refused when the note has moved on, merged on the device from the version it started from, and sent again", async () => {
    // Version 1 is a draft, 2 the text the plugin started from, 3 an edit made on another device meanwhile.
    const { id } = await world.elsewhere.create("Ideas/a.md", "draft\n");
    await world.elsewhere.update(id, "Ideas/a.md", "one\ntwo\n");
    await world.elsewhere.update(id, "Ideas/a.md", "ONE\ntwo\n");

    const device = await makeDevice(world, {
      files: { "Ideas/a.md": "one\nTWO\n" },
      notes: { "Ideas/a.md": known("Ideas/a.md", "one\ntwo\n", 2, id) },
      cursor: "0",
    });
    await device.engine.push("Ideas/a.md");

    const route = device.log.requests().map((r) => `${r.method} ${r.route}${r.query.version ? ` v${r.query.version}` : ""}`);
    expect(route, "save, refused; read the note now; read the version it started from; save again").toEqual([
      "POST save",
      "GET note",
      "GET note v2",
      "POST save",
    ]);
    const saves = device.log.to("POST save");
    expect(saves.map((s) => s.status)).toEqual([409, 200]);
    expect(await sentNote(world, saves[0]), "the first save is the vault's text, from the stored version").toEqual({
      id, base: 2, kid: world.keys.kid, path: "Ideas/a.md", text: "one\nTWO\n",
    });
    expect(await sentNote(world, saves[1]), "the second is the merge, from the version Nexus is at").toEqual({
      id, base: 3, kid: world.keys.kid, path: "Ideas/a.md", text: "ONE\nTWO\n",
    });
    expect(saves[1].answer).toEqual({ result: "saved", id, version: 4 });

    const writes = device.log.changesToVault();
    expect(writes, "the note is written once, with the merge").toEqual([{ kind: "write", path: "Ideas/a.md", text: "ONE\nTWO\n" }]);
    expect(device.vault.textOf("Ideas/a.md")).toBe("ONE\nTWO\n");
    expect(device.data().notes["Ideas/a.md"]).toMatchObject({ id, version: 4, savedPath: "Ideas/a.md" });
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "ONE\nTWO\n" });
    expect(device.notices, "a merge that worked is not announced").toEqual([]);
  });

  it("stores the version a plain save is given, and leaves the note's text alone", async () => {
    const { id } = await world.elsewhere.create("Ideas/b.md", "alpha\n");
    const device = await makeDevice(world, {
      files: { "Ideas/b.md": "alpha\nbeta\n" },
      notes: { "Ideas/b.md": known("Ideas/b.md", "alpha\n", 1, id) },
      cursor: "0",
    });
    await device.engine.push("Ideas/b.md");

    const saves = device.log.to("POST save");
    expect(saves).toHaveLength(1);
    expect(await sentNote(world, saves[0])).toMatchObject({ id, base: 1, path: "Ideas/b.md", text: "alpha\nbeta\n" });
    expect(saves[0].answer).toEqual({ result: "saved", id, version: 2 });
    expect(device.data().notes["Ideas/b.md"].version).toBe(2);
    expect(device.log.changesToVault(), "the vault already holds the text that was saved").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "alpha\nbeta\n" });
  });

  it("sends a note that Nexus has never seen with base 0 and an id made here, and stores version 1", async () => {
    const device = await makeDevice(world, { files: { "Ideas/new.md": "fresh\n" }, cursor: "0" });
    await device.engine.push("Ideas/new.md");

    const saves = device.log.to("POST save");
    expect(saves).toHaveLength(1);
    const sent = await sentNote(world, saves[0]);
    expect(sent).toMatchObject({ base: 0, path: "Ideas/new.md", text: "fresh\n" });
    expect(sent.id, "an id made at random, which is not the path").toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(device.data().notes["Ideas/new.md"]).toMatchObject({ id: sent.id, version: 1 });
    expect(await nexusTexts(world)).toEqual({ "Ideas/new.md": "fresh\n" });
  });

  it("keeps a new note's id from before its first save is confirmed, so a save whose answer was lost is sent again as the same note", async () => {
    const device = await makeDevice(world, { files: { "Ideas/lost.md": "fresh\n" }, cursor: "0" });
    device.network.online = false;
    await device.engine.push("Ideas/lost.md");
    const idMade = device.data().notes["Ideas/lost.md"];
    expect(idMade, "the id is kept though nothing reached Nexus").toMatchObject({ version: 0 });

    device.network.online = true;
    await device.engine.push("Ideas/lost.md");
    expect(device.data().notes["Ideas/lost.md"]).toMatchObject({ id: idMade.id, version: 1 });
    expect(bodyOf(await world.owner.list()).notes, "one note in Nexus, not two").toHaveLength(1);
  });

  it("finds its own first save already there when the answer was lost, and does not make a second note or a clash", async () => {
    // The save reached Nexus, and the plugin never heard: it had stored the id with version 0.
    const { id } = await world.elsewhere.create("Ideas/landed.md", "fresh\n", "aaaaaaaaaaaaaaaaaaaaaa");
    const device = await makeDevice(world, {
      files: { "Ideas/landed.md": "fresh\n" },
      notes: { "Ideas/landed.md": { id, version: 0, hash: "", savedPath: "" } },
      cursor: "0",
    });
    await device.engine.push("Ideas/landed.md");

    expect(device.data().notes["Ideas/landed.md"]).toMatchObject({ id, version: 1 });
    expect(device.notices).toEqual([]);
    expect(device.vault.texts()).toEqual({ "Ideas/landed.md": "fresh\n" });
    expect(bodyOf(await world.owner.list()).notes).toHaveLength(1);
  });

  it("sends the same text twice only once: an edit that changes nothing is not a new version", async () => {
    const device = await makeDevice(world, { files: { "Ideas/same.md": "steady\n" }, cursor: "0" });
    await device.engine.push("Ideas/same.md");
    await device.engine.push("Ideas/same.md");

    expect(device.log.to("POST save"), "the second push finds nothing new to send").toHaveLength(1);
    const { id } = device.data().notes["Ideas/same.md"];
    expect(bodyOf(await world.owner.history(id)).versions).toHaveLength(1);
  });
});

describe("an edit made while Obsidian was closed", () => {
  it("goes up on the next sync, and so does a note made then; notes that did not change are not sent again", async () => {
    // The vault is on iCloud and edited on other devices, so its files change while Obsidian is not running.
    const before = await syncedDevice(world, { "Ideas/closed.md": "before\n", "Ideas/steady.md": "steady\n" });
    before.vault.type("Ideas/closed.md", "edited while closed\n");
    before.vault.type("Ideas/made-while-closed.md", "a new note\n");

    const reopened = await makeDevice(world, { vault: before.vault, from: before.data(), unlock: before.unlock });
    await reopened.engine.sync();

    expect(await nexusTexts(world)).toEqual({
      "Ideas/closed.md": "edited while closed\n",
      "Ideas/steady.md": "steady\n",
      "Ideas/made-while-closed.md": "a new note\n",
    });
    const sent = await Promise.all(reopened.log.to("POST save").map((s) => sentNote(world, s)));
    expect(sent.map((n) => n.path).sort(), "only the two that changed are sent").toEqual(["Ideas/closed.md", "Ideas/made-while-closed.md"]);
    expect(sent.find((n) => n.path === "Ideas/closed.md")?.base, "the edit builds on the stored version").toBe(1);
    expect(reopened.data().notes["Ideas/closed.md"].version).toBe(2);
    expect(reopened.data().notes["Ideas/made-while-closed.md"].version).toBe(1);
  });
});

describe("how the plugin talks to Nexus", () => {
  it("asks requestUrl not to throw, sends JSON as JSON, and carries the token on every call", async () => {
    const { id } = await world.elsewhere.create("Ideas/c.md", "one\ntwo\n");
    await world.elsewhere.update(id, "Ideas/c.md", "one\nREMOTE\n");
    const device = await makeDevice(world, {
      files: { "Ideas/c.md": "one\nLOCAL\n", "Ideas/d.md": "fresh\n" },
      notes: { "Ideas/c.md": known("Ideas/c.md", "one\ntwo\n", 1, id) },
      cursor: "0",
    });

    await device.engine.push("Ideas/d.md");
    await device.engine.push("Ideas/c.md");
    await device.engine.sync();

    const calls = device.log.requests();
    expect(calls.length, "a save, a refused save and a pull were made").toBeGreaterThanOrEqual(3);
    const statuses = device.log.to("POST save").map((c) => c.status);
    expect(statuses, "one save went through and one was refused").toEqual(expect.arrayContaining([200, 409]));
    for (const call of calls) {
      const named = `${call.method} ${call.route}`;
      expect(call.throwFlag, `${named} passes throw: false, or a 409 would be an exception`).toBe(false);
      expect(call.authorization, `${named} carries the token`).toBe(`Bearer ${world.token}`);
      if (call.method === "POST") expect(call.contentType, `${named} declares its body as JSON`).toMatch(/^application\/json/i);
    }
  });
});
