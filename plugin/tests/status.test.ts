// The status line: the last sync time, or what went wrong in plain words (signed out, offline, not allowed). Nothing
// that goes wrong ever throws into Obsidian or costs a note its text, and an edit made while Nexus could not be
// reached goes up on a later sync. (Signed out is held in sign-in.test.ts.) Against the in-memory Nexus (see
// world.ts), with the network cut by the test and the identity `agents`, which may not touch Private/.

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

const TROUBLE = /signed out|offline|not allowed/i;
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
    bodyOf(await world.agents.save("Ideas/elsewhere.md", "made while this device was offline\n"));
    device.vault.type("Ideas/a.md", "a note, edited offline\n");

    await expect(device.engine.sync()).resolves.toBeUndefined();
    await expect(device.engine.push("Ideas/a.md")).resolves.toBeUndefined();

    expect(device.engine.status()).toMatch(/offline/i);
    expect(device.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(device.vault.texts(), "the vault is as it was, the edit included").toEqual({ "Ideas/a.md": "a note, edited offline\n" });
    expect(device.data().versions).toEqual({ "Ideas/a.md": 1 });
  });

  it("carries on when the network is back: what was missed comes down and the edit made offline goes up", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a note\n" });
    device.network.online = false;
    bodyOf(await world.agents.save("Ideas/elsewhere.md", "made while this device was offline\n"));
    device.vault.type("Ideas/a.md", "a note, edited offline\n");
    await device.engine.push("Ideas/a.md");
    await device.engine.sync();
    expect(device.engine.status()).toMatch(/offline/i);

    device.network.online = true;
    await device.engine.sync();

    expect(device.engine.status(), "the trouble is gone from the line").not.toMatch(TROUBLE);
    expect(device.vault.textOf("Ideas/elsewhere.md")).toBe("made while this device was offline\n");
    expect(await nexusTexts(world), "the offline edit reached Nexus").toMatchObject({ "Ideas/a.md": "a note, edited offline\n" });
    expect(device.data().versions["Ideas/a.md"]).toBe(2);
  });

  it("says not allowed, in plain words, when the identity may not write there, and keeps the note as it is", async () => {
    const agents = await world.tokenFor("agents", "an agent's device");
    const device = await makeDevice(world, { token: agents, files: { "Private/diary.md": "mine alone\n", "Ideas/ok.md": "fine\n" }, cursor: "0" });

    await expect(device.engine.push("Private/diary.md")).resolves.toBeUndefined();

    expect(device.log.to("POST save")[0].status, "Nexus refused the folder").toBe(403);
    expect(device.engine.status()).toMatch(/not allowed/i);
    expect(device.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(device.vault.textOf("Private/diary.md")).toBe("mine alone\n");
    expect(device.data().versions["Private/diary.md"]).toBeUndefined();
    expect(device.data().token, "a refusal is not a reason to forget the token").toBe(agents);

    await device.engine.push("Ideas/ok.md");
    expect(device.data().versions["Ideas/ok.md"], "the rest of the vault still syncs").toBe(1);
  });
});
