// A clash copy stays in the vault it was made in. It is never sent to Nexus, however it comes to be looked at: by the
// first sync, by the engine's own write being reported back as an edit, by a later sync or a restart. Renaming it to
// something else makes it an ordinary note again, which is how it is merged by hand and kept. Against the in-memory Nexus
// (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_PAUSE, bodyOf, emptyNexus, fakeTimers, forbidFetch, makeDevice, nexusTexts, openWorld, quiet, type World } from "./world";

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

const COPY = /^Ideas\/a \(clash Test iPhone 2026-11-14[^)]*\)\.md$/;

/** A note that clashed on a send: the vault's edit and another device's edit touch the same line. */
async function clashedDevice() {
  bodyOf(await world.agents.save("Ideas/a.md", "zero\n"));
  bodyOf(await world.agents.save("Ideas/a.md", "one\ntwo\n", { base: 1 }));
  bodyOf(await world.agents.save("Ideas/a.md", "one\nREMOTE\n", { base: 2 }));
  const device = await makeDevice(world, { files: { "Ideas/a.md": "one\nLOCAL\n" }, versions: { "Ideas/a.md": 2 }, cursor: "0" });
  await device.engine.push("Ideas/a.md");
  const copies = device.vault.pathsStarting("Ideas/a (clash ");
  expect(copies, "the clash made its one copy").toHaveLength(1);
  expect(copies[0]).toMatch(COPY);
  return { device, copy: copies[0] };
}

const sentPaths = (device: Awaited<ReturnType<typeof clashedDevice>>["device"]) => device.log.to("POST save").map((c) => c.body.path);

describe("a clash copy", () => {
  it("is not sent by a sync, by the vault reporting its creation, or by a restart", async () => {
    const { device, copy } = await clashedDevice();

    await device.engine.sync();
    fakeTimers();
    device.engine.edited(copy); // Obsidian reports the engine's own write of the copy
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);
    vi.useRealTimers();
    await device.engine.push(copy);
    const restarted = await makeDevice(world, { vault: device.vault, from: device.data() });
    await restarted.engine.sync();
    await quiet(restarted.log);

    expect(sentPaths(device), "only the note's own send, which clashed").toEqual(["Ideas/a.md"]);
    expect(restarted.log.to("POST save")).toEqual([]);
    expect(Object.keys(await nexusTexts(world))).toEqual(["Ideas/a.md"]);
    expect(device.vault.textOf(copy), "and it is still in the vault, untouched").toBe("one\nLOCAL\n");
    expect(device.data().versions[copy]).toBeUndefined();
  });

  it("made by a first sync is not sent either", async () => {
    bodyOf(await world.agents.save("Ideas/a.md", "nexus text\n"));
    const device = await makeDevice(world, { files: { "Ideas/a.md": "vault text\n" } });
    await device.engine.sync();
    await device.engine.sync();

    expect(device.vault.pathsStarting("Ideas/a (clash ")).toHaveLength(1);
    expect(Object.keys(await nexusTexts(world))).toEqual(["Ideas/a.md"]);
  });

  it("goes up as an ordinary note once it is renamed, which is how a merged copy is kept", async () => {
    const { device, copy } = await clashedDevice();
    await device.vault.rename(copy, "Ideas/a merged.md");
    fakeTimers();
    await device.engine.renamed(copy, "Ideas/a merged.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);
    vi.useRealTimers();
    await quiet(device.log);

    expect(await nexusTexts(world)).toMatchObject({ "Ideas/a merged.md": "one\nLOCAL\n" });
  });
});
