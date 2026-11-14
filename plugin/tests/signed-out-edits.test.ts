// An edit made while the plugin is signed out is kept waiting and goes up once the person signs in again, without a restart
// of Obsidian. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_PAUSE, emptyNexus, fakeTimers, forbidFetch, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

describe("an edit made while signed out", () => {
  it("goes up on the first sync after signing in again, though the vault was already looked at this run", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    await device.engine.sync(); // the start-up look at the vault is done, as in a plugin that has been running

    device.deps.data.token = null; // signed out
    fakeTimers();
    device.vault.type("Ideas/a.md", "a, edited while signed out\n");
    device.engine.edited("Ideas/a.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);
    expect(device.log.to("POST save"), "nothing is sent signed out").toEqual([]);
    expect(device.engine.status()).toMatch(/signed out/i);
    vi.useRealTimers();

    device.deps.data.token = world.token; // signed in again
    await device.engine.sync();

    expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "a, edited while signed out\n", "Ideas/b.md": "b\n" });
    expect(device.engine.status()).toMatch(/last synced/i);
  });
});
