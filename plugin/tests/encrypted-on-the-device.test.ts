// Every note leaves the device only as an encrypted blob, and Nexus can read none of it. Two devices are unlocked with the same vault
// key. Device A writes a note and syncs; everything the server then holds (every row of every table), everything A sent and
// everything the server answered is searched for the note's path, folder, name and text, in the plain and in each way they could be
// written down, and none is found. Device B syncs and has the same note with the same text. The blob that is held opens with the key,
// and only with it. Against the real server (see real-nexus.ts); the search is the one the server's own no-plaintext test makes.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { foundIn, needlesFor } from "./leaks";
import { bodyOf, emptyNexus, everythingStored, forbidFetch, nexusNotes, openBlob, openWorld, syncedDevice, type Device, type World } from "./world";

const PATH = "Daily/2026-11-15.md";
const TEXT = "Remember the garden plan.\nBuy seed potatoes in March.\nCafé ✨ 日本語\n";

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

/** Everything a device sent to Nexus (route, query and body) and everything Nexus answered it, as one text. */
const traffic = (device: Device): string =>
  JSON.stringify(device.log.requests().map((r) => [r.method, r.route, r.query, r.body, r.status, r.answer]));

describe("a note on one device, and the same note on another", () => {
  it("reaches the server only as a blob, and device B ends with the same note and the same text", async () => {
    const needles = needlesFor([{ path: PATH, text: TEXT }]);
    const a = await syncedDevice(world, {}, { name: "Device A", token: await world.tokenFor(world.user, "device A") });
    const b = await syncedDevice(world, {}, { name: "Device B", token: await world.tokenFor(world.user, "device B") });

    a.vault.type(PATH, TEXT);
    await a.engine.push(PATH);
    await a.engine.sync();
    const { id, version } = a.data().notes[PATH];
    expect(version).toBe(1);

    // What the server holds: one note, one version, and bytes.
    const stored = everythingStored();
    expect(stored, "the look is at the real tables").toContain("nexus_versions");
    expect(stored).toContain(id);
    expect(foundIn(stored, needles), "no path, folder, name or text is in any row of any table").toEqual([]);
    const row = bodyOf(await world.owner.note(id));
    expect(row).toMatchObject({ id, version: 1, kind: "save", kid: world.keys.kid });
    expect(typeof row.blob).toBe("string");
    expect(Buffer.from(row.blob, "base64").length, "bytes, of the size the padding gives").toBeGreaterThanOrEqual(301);
    expect(Buffer.from(row.blob, "base64")[0], "the first byte is the format version").toBe(1);

    // What A sent and what it was answered.
    expect(foundIn(traffic(a), needles), "nothing A sent or was told holds a path or a text").toEqual([]);

    // The blob opens with the vault's key, and says what the note is.
    expect(await openBlob(world.keys, id, row.blob)).toEqual({ path: PATH, text: TEXT });

    // Device B syncs and has the same note.
    await b.engine.sync();
    expect(b.vault.textOf(PATH)).toBe(TEXT);
    expect(b.vault.texts()).toEqual({ [PATH]: TEXT });
    expect(b.data().notes[PATH]).toMatchObject({ id, version: 1 });
    expect(foundIn(traffic(b), needles), "nothing B sent or was told holds a path or a text either").toEqual([]);
    expect(b.log.to("POST save"), "B had nothing to send").toEqual([]);
    expect(await nexusNotes(world)).toEqual({ [id]: { path: PATH, text: TEXT, version: 1 } });
  });

  it("sends a save that holds an id, a base, a key number and a blob, and nothing else: no path, no text, no hash of either", async () => {
    const a = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device A saves") });
    a.vault.type(PATH, TEXT);
    await a.engine.push(PATH);
    const saves = a.log.to("POST save");
    expect(saves).toHaveLength(1);
    expect(Object.keys(saves[0].body).sort()).toEqual(["base", "blob", "id", "kid"]);
    expect(saves[0].body.id, "an id made at random, which is not the path or a part of it").toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(saves[0].body.kid).toBe(world.keys.kid);
    expect(saves[0].body.blob).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("asks for a note by its id, never by its path", async () => {
    const a = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device A asks") });
    a.vault.type(PATH, "one\ntwo\n");
    await a.engine.push(PATH);
    const { id } = a.data().notes[PATH];
    await world.elsewhere.update(id, PATH, "ONE\ntwo\n");
    a.vault.type(PATH, "one\nTWO\n");
    await a.engine.push(PATH); // refused: the note is read to merge

    const reads = a.log.to("GET note");
    expect(reads.length, "the note was read to be merged").toBeGreaterThanOrEqual(2);
    for (const read of reads) expect(read.query.id, "by id").toBe(id);
    for (const request of a.log.requests()) expect(JSON.stringify([request.query, request.route]), "no request names the path").not.toContain("Daily");
  });
});

describe("a rename", () => {
  it("changes the path inside the blob and never the id, and the server still holds no path", async () => {
    const needles = needlesFor([{ path: PATH, text: TEXT }, { path: "Moved/Elsewhere.md", text: TEXT }]);
    const a = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device A renames") });
    a.vault.type(PATH, TEXT);
    await a.engine.push(PATH);
    const { id } = a.data().notes[PATH];

    await a.vault.rename(PATH, "Moved/Elsewhere.md");
    await a.engine.renamed(PATH, "Moved/Elsewhere.md");

    expect(a.data().notes["Moved/Elsewhere.md"], "the same id, the next version").toMatchObject({ id, version: 2 });
    const history = bodyOf(await world.owner.history(id)).versions as Array<{ version: number }>;
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    const first = await openBlob(world.keys, id, bodyOf(await world.owner.note(id, 1)).blob);
    const second = await openBlob(world.keys, id, bodyOf(await world.owner.note(id, 2)).blob);
    expect(first.path, "version 1 has the old path").toBe(PATH);
    expect(second.path, "version 2 has the new one").toBe("Moved/Elsewhere.md");
    expect(foundIn(everythingStored(), needles)).toEqual([]);
    expect(foundIn(traffic(a), needles)).toEqual([]);
  });
});

describe("the search for a path or a text", () => {
  it("does find them where they are: a note saved as plain bytes, by something that does not encrypt, is caught in what the server holds", async () => {
    const needles = needlesFor([{ path: PATH, text: TEXT }]);
    expect(foundIn(`x ${PATH} x`, needles)).toContain(PATH);
    expect(foundIn(JSON.stringify({ text: TEXT }), needles).length).toBeGreaterThan(0);
    expect(foundIn(encodeURIComponent(PATH), needles)).toContain(encodeURIComponent(PATH));
    expect(needles.length, "a good many things are looked for").toBeGreaterThan(30);

    // The server takes any base64 as a blob, so a writer that did not encrypt would put the record in it as it is.
    const plain = Buffer.from(JSON.stringify({ path: PATH, text: TEXT }), "utf8").toString("base64");
    bodyOf(await world.agents.save("control-note", plain, { base: 0, kid: world.keys.kid }));
    expect(foundIn(everythingStored(), needles), "and what is held is searched").not.toEqual([]);
  });
});
