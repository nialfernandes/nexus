// Two devices of one person, each a plugin with its own vault, name and token, kept in step by the real Nexus server (see
// real-nexus.ts): what one saves the other pulls, and two edits made at the same moment to different lines are merged by the
// server's own store and come down on both sides as the same text. Nothing passes between the two devices but the server's routes.
//
// The worked example: device A makes Ideas/shared.md and saves it; device B pulls it. Then A changes the first line and B
// changes the last line, both starting from version 1. A saves first (version 2); B's save starts from version 1 and the server
// merges it into version 3, `ONE\ntwo\nTHREE\n`; B writes the merged text, and A pulls it.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, manage, nexusTexts, openWorld, syncedDevice, type World } from "./world";

const PATH = "Ideas/shared.md";

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

describe("two devices of one person", () => {
  it("pull what the other saved, and an edit to other lines made at the same moment is merged by the server", async () => {
    const a = await syncedDevice(world, {}, { name: "Device A", token: await world.tokenFor(world.user, "device A") });
    const b = await syncedDevice(world, {}, { name: "Device B", token: await world.tokenFor(world.user, "device B") });

    a.vault.type(PATH, "one\ntwo\nthree\n");
    await a.engine.push(PATH);
    expect(a.log.to("POST save")[0].answer, "the server kept it as the note's first version").toEqual({ result: "saved", path: PATH, version: 1 });

    await b.engine.sync();
    expect(b.vault.textOf(PATH), "device B pulled the text device A saved").toBe("one\ntwo\nthree\n");
    expect(b.data().versions[PATH]).toBe(1);
    expect(b.log.to("POST save"), "pulling sends nothing up").toEqual([]);

    a.vault.type(PATH, "ONE\ntwo\nthree\n");
    b.vault.type(PATH, "one\ntwo\nTHREE\n");
    await a.engine.push(PATH);
    await b.engine.push(PATH);
    expect(a.log.to("POST save").at(-1)!.answer).toEqual({ result: "saved", path: PATH, version: 2 });
    expect(b.log.to("POST save").at(-1)!.body, "device B started from version 1").toEqual({ path: PATH, text: "one\ntwo\nTHREE\n", base: 1 });
    expect(b.log.to("POST save").at(-1)!.answer, "the server merged the two edits").toEqual({ result: "merged", path: PATH, version: 3 });
    expect(b.vault.textOf(PATH), "device B holds the merged text").toBe("ONE\ntwo\nTHREE\n");

    await a.engine.sync();
    expect(a.vault.textOf(PATH), "device A pulled the merged text").toBe("ONE\ntwo\nTHREE\n");
    expect(a.data().versions[PATH]).toBe(3);
    expect(await nexusTexts(world)).toEqual({ [PATH]: "ONE\ntwo\nTHREE\n" });
    expect(a.notices.concat(b.notices), "no clash, so nobody is told anything").toEqual([]);

    const history = bodyOf(await world.owner.history(PATH)).versions as Array<{ version: number; merged: boolean; clash: boolean; writer: string }>;
    expect(history.map((v) => [v.version, v.merged, v.clash])).toEqual([[1, false, false], [2, false, false], [3, true, false]]);

    const labels = (bodyOf(await manage({ cookie: world.ownerCookie }).tokens()).tokens as Array<{ label: string; lastUsedAt: number | null }>)
      .filter((t) => t.label === "device A" || t.label === "device B");
    expect(labels.map((t) => t.label).sort(), "each device made its calls with a token of its own").toEqual(["device A", "device B"]);
    expect(labels.every((t) => t.lastUsedAt !== null), "and the server saw each one used").toBe(true);
  });
});
