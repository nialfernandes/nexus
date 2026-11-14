// The status line: the last sync time, or what went wrong in plain words (signed out, offline, locked, a note Nexus would not take). Nothing
// that goes wrong ever throws into Obsidian or costs a note its text, and an edit made while Nexus could not be
// reached goes up on a later sync. (Signed out is held in sign-in.test.ts, locked in locked.test.ts.) Against the in-memory
// Nexus (see world.ts), with the network cut by the test and the identity `agents` as another writer.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyNexus, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

const TROUBLE = /signed out|offline|locked|would not take/i;
const JARGON = /\b(401|403|409|500|503|http|status code|errno|econn\w*|err_\w+)\b/i;

describe("the status line", () => {
  it("names the time of the last sync once a sync has worked", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a note\n" });
    await device.engine.sync();

    const line = device.engine.status();
    expect(line, "a time has digits in it").toMatch(/\d/);
    expect(line, "and nothing is wrong").not.toMatch(TROUBLE);
    expect(line).not.toContain(world.token);
  });

  it("says offline, in plain words, when Nexus cannot be reached, and loses nothing", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a note\n" });
    device.network.online = false;
    await world.elsewhere.create("Ideas/elsewhere.md", "made while this device was offline\n");
    device.vault.type("Ideas/a.md", "a note, edited offline\n");

    await expect(device.engine.sync()).resolves.toBeUndefined();
    await expect(device.engine.push("Ideas/a.md")).resolves.toBeUndefined();

    expect(device.engine.status()).toMatch(/offline/i);
    expect(device.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(device.vault.texts(), "the vault is as it was, the edit included").toEqual({ "Ideas/a.md": "a note, edited offline\n" });
    expect(device.data().notes["Ideas/a.md"].version, "and it still stands on the version it had").toBe(1);
  });

  it("carries on when the network is back: what was missed comes down and the edit made offline goes up", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a note\n" });
    device.network.online = false;
    await world.elsewhere.create("Ideas/elsewhere.md", "made while this device was offline\n");
    device.vault.type("Ideas/a.md", "a note, edited offline\n");
    await device.engine.push("Ideas/a.md");
    await device.engine.sync();
    expect(device.engine.status()).toMatch(/offline/i);

    device.network.online = true;
    await device.engine.sync();

    expect(device.engine.status(), "the trouble is gone from the line").not.toMatch(TROUBLE);
    expect(device.vault.textOf("Ideas/elsewhere.md")).toBe("made while this device was offline\n");
    expect(await nexusTexts(world), "the offline edit reached Nexus").toMatchObject({ "Ideas/a.md": "a note, edited offline\n" });
    expect(device.data().notes["Ideas/a.md"].version).toBe(2);
  });

  it("says Nexus would not take a note, in plain words, when it refuses it, and keeps the note as it is", async () => {
    const tooBig = "x".repeat(1_100_000); // more than Nexus keeps in one note
    const device = await makeDevice(world, { files: { "Big/diary.md": tooBig, "Ideas/ok.md": "fine\n" }, cursor: "0" });

    await expect(device.engine.push("Big/diary.md")).resolves.toBeUndefined();

    expect(device.log.to("POST save")[0].status, "Nexus refused the note").toBe(413);
    expect(device.engine.status()).toMatch(/would not take diary\.md/i);
    expect(device.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(device.vault.textOf("Big/diary.md")).toBe(tooBig);
    expect(device.data().notes["Big/diary.md"]?.version ?? 0, "it never stood on a version").toBe(0);
    expect(device.data().token, "a refusal is not a reason to forget the token").toBe(world.token);

    await device.engine.push("Ideas/ok.md");
    expect(device.data().notes["Ideas/ok.md"].version, "the rest of the vault still syncs").toBe(1);
  });
});
