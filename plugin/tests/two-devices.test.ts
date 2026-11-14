// Two devices of one person, each a plugin with its own vault, name and token, unlocked with the same vault key and kept in step by
// the real Nexus server (see real-nexus.ts): what one saves the other pulls, and two edits made at the same moment to different lines
// are merged ON THE DEVICE that is refused, and come down on both sides as the same text. Nothing passes between the two devices but
// the server's routes, and the server holds nothing but blobs.
//
// The worked example: device A makes Ideas/shared.md and saves it; device B pulls it. Then A changes the first line and B
// changes the last line, both starting from version 1. A saves first (version 2); B's save starts from version 1 and the server
// refuses it. B reads version 2, reads version 1 (what it started from), merges the three into `ONE\ntwo\nTHREE\n`, saves that from
// version 2 (it is version 3), and A pulls it.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, manage, nexusTexts, openWorld, sentNote, syncedDevice, type World } from "./world";

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
  it("pull what the other saved, and an edit to other lines made at the same moment is merged by the device that Nexus refused", async () => {
    const a = await syncedDevice(world, {}, { name: "Device A", token: await world.tokenFor(world.user, "device A") });
    const b = await syncedDevice(world, {}, { name: "Device B", token: await world.tokenFor(world.user, "device B") });

    a.vault.type(PATH, "one\ntwo\nthree\n");
    await a.engine.push(PATH);
    const id = a.data().notes[PATH].id;
    expect(a.log.to("POST save")[0].answer, "the server kept it as the note's first version").toEqual({ result: "saved", id, version: 1 });

    await b.engine.sync();
    expect(b.vault.textOf(PATH), "device B pulled the text device A saved").toBe("one\ntwo\nthree\n");
    expect(b.data().notes[PATH], "under the id device A made for it").toMatchObject({ id, version: 1 });
    expect(b.log.to("POST save"), "pulling sends nothing up").toEqual([]);

    a.vault.type(PATH, "ONE\ntwo\nthree\n");
    b.vault.type(PATH, "one\ntwo\nTHREE\n");
    await a.engine.push(PATH);
    await b.engine.push(PATH);

    expect(a.log.to("POST save").at(-1)!.answer).toEqual({ result: "saved", id, version: 2 });
    const bSaves = b.log.to("POST save");
    expect(bSaves.map((s) => s.status), "device B's first save was refused, and its second went through").toEqual([409, 200]);
    expect(await sentNote(world, bSaves[0]), "device B started from version 1").toMatchObject({ id, base: 1, text: "one\ntwo\nTHREE\n" });
    expect(await sentNote(world, bSaves[1]), "and saved the merge from version 2").toMatchObject({ id, base: 2, text: "ONE\ntwo\nTHREE\n" });
    expect(bSaves[1].answer).toEqual({ result: "saved", id, version: 3 });
    expect(b.vault.textOf(PATH), "device B holds the merged text").toBe("ONE\ntwo\nTHREE\n");

    await a.engine.sync();
    expect(a.vault.textOf(PATH), "device A pulled the merged text").toBe("ONE\ntwo\nTHREE\n");
    expect(a.data().notes[PATH]).toMatchObject({ id, version: 3 });
    expect(await nexusTexts(world)).toEqual({ [PATH]: "ONE\ntwo\nTHREE\n" });
    expect(a.notices.concat(b.notices), "no clash, so nobody is told anything").toEqual([]);

    const history = bodyOf(await world.owner.history(id)).versions as Array<{ version: number; kind: string; writer: string }>;
    expect(history.map((v) => [v.version, v.kind])).toEqual([[1, "save"], [2, "save"], [3, "save"]]);

    const labels = (bodyOf(await manage({ cookie: world.ownerCookie }).tokens()).tokens as Array<{ label: string; lastUsedAt: number | null }>)
      .filter((t) => t.label === "device A" || t.label === "device B");
    expect(labels.map((t) => t.label).sort(), "each device made its calls with a token of its own").toEqual(["device A", "device B"]);
    expect(labels.every((t) => t.lastUsedAt !== null), "and the server saw each one used").toBe(true);
  });

  it("end with the merged text when both sync, with no refused save left over: the pull leaves the edit to be merged and sent", async () => {
    const a = await syncedDevice(world, {}, { name: "Device A", token: await world.tokenFor(world.user, "device A 2") });
    const b = await syncedDevice(world, {}, { name: "Device B", token: await world.tokenFor(world.user, "device B 2") });
    a.vault.type(PATH, "one\ntwo\nthree\n");
    await a.engine.sync();
    await b.engine.sync();

    // Both edit while their apps are closed, then open them again: A first, then B. (A sync looks at every file when the app comes
    // back to the front; the edits made with the app closed made no event.)
    a.vault.type(PATH, "ONE\ntwo\nthree\n");
    b.vault.type(PATH, "one\ntwo\nTHREE\n");
    await a.engine.cameToFront();
    await b.engine.cameToFront();
    await a.engine.cameToFront();

    expect(a.vault.textOf(PATH)).toBe("ONE\ntwo\nTHREE\n");
    expect(b.vault.textOf(PATH)).toBe("ONE\ntwo\nTHREE\n");
    expect(await nexusTexts(world)).toEqual({ [PATH]: "ONE\ntwo\nTHREE\n" });
    expect(b.log.to("POST save").map((s) => s.status), "device B's save was refused once, then merged and saved").toEqual([409, 200]);
    expect(a.notices.concat(b.notices)).toEqual([]);
  });

  it("keep both texts when the edits touch the same line, and the same on each device: one has a copy of what the other wrote", async () => {
    const a = await syncedDevice(world, {}, { name: "Device A", token: await world.tokenFor(world.user, "device A 3") });
    const b = await syncedDevice(world, {}, { name: "Device B", token: await world.tokenFor(world.user, "device B 3") });
    a.vault.type(PATH, "one\ntwo\n");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.type(PATH, "one\nfrom A\n");
    b.vault.type(PATH, "one\nfrom B\n");
    await a.engine.cameToFront();
    await b.engine.cameToFront();
    await a.engine.cameToFront();

    expect(b.vault.textOf(PATH), "device B's note holds what Nexus had, A's text").toBe("one\nfrom A\n");
    expect(b.vault.pathsStarting("Ideas/shared (clash ").map((p) => b.vault.textOf(p)), "and its own text is kept beside it").toEqual(["one\nfrom B\n"]);
    expect(a.vault.textOf(PATH)).toBe("one\nfrom A\n");
    expect(a.vault.pathsStarting("Ideas/shared (clash "), "device A had nothing to keep").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ [PATH]: "one\nfrom A\n" });
    expect(b.notices).toHaveLength(1);
  });
});
