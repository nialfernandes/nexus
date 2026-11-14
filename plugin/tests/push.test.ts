// A local edit goes up to Nexus with the version the plugin last saw as its base, and what Nexus answers decides
// what the vault holds next. Against the in-memory Nexus (see world.ts for the contract and where each
// piece comes from).
//
// The worked example: Ideas/a.md is at stored version 2, the vault's text is `one\nTWO\n`, and Nexus has moved on to
// version 3 (`ONE\ntwo\n`). The plugin sends one save with base 2; Nexus merges the two edits into version 4,
// `ONE\nTWO\n`; the plugin writes that text to the note and stores version 4. A save's answer carries the version and
// not the text, so the text comes from reading the note.

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

describe("a local edit goes up", () => {
  it("sends the stored version as base, and writes the merged text Nexus answers with", async () => {
    // Version 1 is a draft, 2 the text the plugin started from, 3 an edit made on another device meanwhile.
    bodyOf(await world.agents.save("Ideas/a.md", "draft\n"));
    bodyOf(await world.agents.save("Ideas/a.md", "one\ntwo\n", { base: 1 }));
    bodyOf(await world.agents.save("Ideas/a.md", "ONE\ntwo\n", { base: 2 }));

    const device = await makeDevice(world, {
      files: { "Ideas/a.md": "one\nTWO\n" },
      versions: { "Ideas/a.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/a.md");

    const saves = device.log.to("POST save");
    expect(saves, "one save is sent").toHaveLength(1);
    expect(saves[0].body).toEqual({ path: "Ideas/a.md", text: "one\nTWO\n", base: 2 });
    expect(saves[0].authorization).toBe(`Bearer ${world.token}`);
    expect(saves[0].answer, "Nexus merged the two edits into version 4").toEqual({ result: "merged", path: "Ideas/a.md", version: 4 });

    const saveAt = device.log.timeline.findIndex((s) => s.kind === "request" && s.seen.route === "save");
    const writes = device.log.timeline.flatMap((s, at) => (s.kind === "write" && s.path === "Ideas/a.md" ? [{ at, text: s.text }] : []));
    expect(writes, "the note is written once").toHaveLength(1);
    expect(writes[0].at, "after the save").toBeGreaterThan(saveAt);
    expect(writes[0].text).toBe("ONE\nTWO\n");
    expect(device.vault.textOf("Ideas/a.md")).toBe("ONE\nTWO\n");
    expect(device.data().versions["Ideas/a.md"]).toBe(4);
    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "ONE\nTWO\n" });
  });

  it("stores the version a plain save is given, and leaves the note's text alone", async () => {
    bodyOf(await world.agents.save("Ideas/b.md", "alpha\n"));
    const device = await makeDevice(world, {
      files: { "Ideas/b.md": "alpha\nbeta\n" },
      versions: { "Ideas/b.md": 1 },
      cursor: "0",
    });
    await device.engine.push("Ideas/b.md");

    const saves = device.log.to("POST save");
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toEqual({ path: "Ideas/b.md", text: "alpha\nbeta\n", base: 1 });
    expect(saves[0].answer).toEqual({ result: "saved", path: "Ideas/b.md", version: 2 });
    expect(device.data().versions["Ideas/b.md"]).toBe(2);
    expect(device.log.changesToVault(), "the vault already holds the text that was saved").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Ideas/b.md": "alpha\nbeta\n" });
  });

  it("sends a note that Nexus has never seen with no base, and stores version 1", async () => {
    const device = await makeDevice(world, { files: { "Ideas/new.md": "fresh\n" }, cursor: "0" });
    await device.engine.push("Ideas/new.md");

    const saves = device.log.to("POST save");
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toEqual({ path: "Ideas/new.md", text: "fresh\n" });
    expect(device.data().versions["Ideas/new.md"]).toBe(1);
    expect(await nexusTexts(world)).toEqual({ "Ideas/new.md": "fresh\n" });
  });

  it("sends the same text twice only once: an edit that changes nothing is not a new version", async () => {
    const device = await makeDevice(world, { files: { "Ideas/same.md": "steady\n" }, cursor: "0" });
    await device.engine.push("Ideas/same.md");
    await device.engine.push("Ideas/same.md");

    expect(device.log.to("POST save"), "the second push finds nothing new to send").toHaveLength(1);
    expect(bodyOf(await world.owner.history("Ideas/same.md")).versions).toHaveLength(1);
  });
});

describe("an edit made while Obsidian was closed", () => {
  it("goes up on the next sync, and so does a note made then; notes that did not change are not sent again", async () => {
    // The vault is on iCloud and edited on other devices, so its files change while Obsidian is not running.
    const before = await syncedDevice(world, { "Ideas/closed.md": "before\n", "Ideas/steady.md": "steady\n" });
    before.vault.type("Ideas/closed.md", "edited while closed\n");
    before.vault.type("Ideas/made-while-closed.md", "a new note\n");

    const reopened = await makeDevice(world, { vault: before.vault, from: before.data() });
    await reopened.engine.sync();

    expect(await nexusTexts(world)).toEqual({
      "Ideas/closed.md": "edited while closed\n",
      "Ideas/steady.md": "steady\n",
      "Ideas/made-while-closed.md": "a new note\n",
    });
    expect(reopened.log.to("POST save").map((c) => c.body.path).sort(), "only the two that changed are sent").toEqual([
      "Ideas/closed.md",
      "Ideas/made-while-closed.md",
    ]);
    expect(reopened.log.to("POST save").find((c) => c.body.path === "Ideas/closed.md")?.body.base, "the edit builds on the stored version").toBe(1);
    expect(reopened.data().versions["Ideas/closed.md"]).toBe(2);
    expect(reopened.data().versions["Ideas/made-while-closed.md"]).toBe(1);
  });
});

describe("how the plugin talks to Nexus", () => {
  it("asks requestUrl not to throw, sends JSON as JSON, and carries the token on every call", async () => {
    bodyOf(await world.agents.save("Ideas/c.md", "one\ntwo\n"));
    bodyOf(await world.agents.save("Ideas/c.md", "one\nREMOTE\n", { base: 1 }));
    const device = await makeDevice(world, {
      files: { "Ideas/c.md": "one\nLOCAL\n", "Ideas/d.md": "fresh\n" },
      versions: { "Ideas/c.md": 1 },
      cursor: "0",
    });

    await device.engine.push("Ideas/d.md");
    await device.engine.push("Ideas/c.md");
    await device.engine.sync();

    const calls = device.log.requests();
    expect(calls.length, "a save, a clash and a pull were made").toBeGreaterThanOrEqual(3);
    const statuses = device.log.to("POST save").map((c) => c.status);
    expect(statuses, "one save went through and one was a clash").toEqual(expect.arrayContaining([200, 409]));
    for (const call of calls) {
      const named = `${call.method} ${call.route}`;
      expect(call.throwFlag, `${named} passes throw: false, or a 409 would be an exception`).toBe(false);
      expect(call.authorization, `${named} carries the token`).toBe(`Bearer ${world.token}`);
      if (call.method === "POST") expect(call.contentType, `${named} declares its body as JSON`).toMatch(/^application\/json/i);
    }
  });
});
