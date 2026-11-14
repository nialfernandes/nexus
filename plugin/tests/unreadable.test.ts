// A blob that does not open is never shown and never written into the vault. Whatever the reason (one byte changed, a blob moved to
// another note's id, a blob made under another key or key number, one cut short) the device keeps the copy it has, the status line
// names the note's id and nothing else (the path is inside the blob and is unknown), the other notes carry on, and the note is read
// again on every sync until it opens. Nexus is the real server, which takes any bytes and cannot tell: the tampering is done through
// its own routes, as whoever runs it could do it. Against the real server (see real-nexus.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KID, blobFor, bodyOf, emptyNexus, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, tampered, type World } from "./world";

const PATH = "Ideas/a.md";

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

const JARGON = /\b(401|403|409|500|http|status code|kid|blob|decrypt\w*|libsodium|aead|nonce)\b/i;

/** Saves `blob` as the next version of note `id`, as whoever holds a token for Nexus could. */
async function saveRaw(id: string, blob: string): Promise<number> {
  const head = bodyOf(await world.agents.note(id)).version as number;
  return bodyOf(await world.agents.save(id, blob, { base: head, kid: world.keys.kid })).version;
}

/** The blob of the note's latest version, as the server holds it. */
const blobOf = async (id: string): Promise<string> => bodyOf(await world.owner.note(id)).blob;

describe("a tampered blob on the server", () => {
  it("is refused by the device that has the note: it keeps its own copy, writes nothing, and the status line names the note's id", async () => {
    const a = await syncedDevice(world, { [PATH]: "the real text\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B") });
    await b.engine.sync();
    expect(b.vault.textOf(PATH)).toBe("the real text\n");
    const { id } = a.data().notes[PATH];
    await saveRaw(id, tampered(await blobOf(id)));

    await b.engine.sync();

    expect(b.vault.textOf(PATH), "device B keeps its own copy").toBe("the real text\n");
    expect(b.log.changesToVault(), "nothing was written into the vault, or taken out of it").toEqual([]);
    expect(b.engine.status(), "the status line names the note by its id").toContain(id);
    expect(b.engine.status(), "and is not the time of a good sync").not.toMatch(/last synced/i);
    expect(b.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(b.notices, "and a notice says so, once").toHaveLength(1);
    expect(b.notices[0]).toContain(id);
    expect(b.data().notes[PATH], "the note still stands on the version it matched").toMatchObject({ id, version: 1 });
    expect(b.log.to("POST save"), "and nothing is sent in answer").toEqual([]);
  });

  it("is asked for again on every sync, without a second notice, and is taken once a good version is saved over it", async () => {
    const a = await syncedDevice(world, { [PATH]: "the real text\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B again") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    await saveRaw(id, tampered(await blobOf(id)));
    await b.engine.sync();

    await b.engine.sync();
    await b.engine.sync();
    expect(b.engine.status(), "still named").toContain(id);
    expect(b.notices, "no more notices").toHaveLength(1);
    expect(b.log.to("GET note").length, "it was read again each time").toBeGreaterThanOrEqual(2);

    // The note is saved again, whole, from the version Nexus is at (what a device that has the real text would do).
    await world.elsewhere.update(id, PATH, "the real text, mended\n");
    await b.engine.sync();
    expect(b.vault.textOf(PATH), "the good version comes down").toBe("the real text, mended\n");
    expect(b.engine.status()).toMatch(/last synced/i);
    expect(b.data().pendingPulls ?? []).toEqual([]);
  });

  it("never shows a note that is new to the device: nothing is written, and the notes beside it still come down", async () => {
    const a = await syncedDevice(world, { [PATH]: "the real text\n" });
    const { id } = a.data().notes[PATH];
    await saveRaw(id, tampered(await blobOf(id)));
    await world.elsewhere.create("Ideas/fine.md", "fine\n");
    const b = await makeDevice(world, { files: { "Mine/local.md": "mine\n" }, token: await world.tokenFor(world.user, "device B new") });
    await b.engine.sync();

    expect(b.vault.texts(), "the note that opened came down; the one that did not did not").toEqual({ "Mine/local.md": "mine\n", "Ideas/fine.md": "fine\n" });
    expect(b.engine.status()).toContain(id);
    const tamperedText = JSON.stringify(b.log.timeline.filter((s) => s.kind === "write"));
    expect(tamperedText).not.toContain("the real text");

    // And a restart does not forget it: the note is still on the list to be read again, and the status names it after the next sync.
    const restarted = await makeDevice(world, { vault: b.vault, from: b.data(), unlock: b.unlock });
    await restarted.engine.sync();
    expect(restarted.engine.status()).toContain(id);
    expect(restarted.vault.texts()).toEqual(b.vault.texts());
  });

  it("is not saved over by an edit made on the device: the edit waits, kept, until the note can be read to merge it", async () => {
    const a = await syncedDevice(world, { [PATH]: "one\ntwo\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B edits") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    const headBefore = bodyOf(await world.owner.note(id)).version;
    await saveRaw(id, tampered(await blobOf(id)));
    b.vault.type(PATH, "one\nTWO\n");

    await b.engine.push(PATH);

    expect(b.vault.textOf(PATH), "the edit is still there").toBe("one\nTWO\n");
    expect(b.engine.status()).toContain(id);
    expect(bodyOf(await world.owner.note(id)).version, "Nexus has only the tampered version added, and nothing of the device's").toBe(headBefore + 1);
    expect(b.log.to("POST save").map((s) => s.status), "its one save was refused").toEqual([409]);
    const calls = b.log.requests().length;
    await b.engine.sync();
    expect(b.log.to("POST save"), "and a sync does not send it into the tampered note either").toHaveLength(1);
    expect(b.log.requests().length - calls, "a few calls to read again, no more").toBeLessThan(8);

    // Once a good version is there, the edit is merged and goes up.
    await world.elsewhere.update(id, PATH, "ONE\ntwo\n");
    await b.engine.sync();
    expect(b.vault.textOf(PATH)).toBe("ONE\nTWO\n");
    expect(await nexusTexts(world)).toEqual({ [PATH]: "ONE\nTWO\n" });
  });
});

describe("a blob that does not belong where it is", () => {
  it("is refused when it is another note's blob under this note's id", async () => {
    const a = await syncedDevice(world, { [PATH]: "mine\n", "Ideas/other.md": "the other note\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B swapped") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    const otherBlob = await blobOf(a.data().notes["Ideas/other.md"].id);
    await saveRaw(id, otherBlob);

    await b.engine.sync();

    expect(b.vault.textOf(PATH), "the swap is not taken").toBe("mine\n");
    expect(b.vault.textOf("Ideas/other.md")).toBe("the other note\n");
    expect(b.engine.status()).toContain(id);
  });

  it("is refused when it was made under another vault key", async () => {
    const a = await syncedDevice(world, { [PATH]: "mine\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B other key") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    const otherKey = { ...world.keys, vaultKey: new Uint8Array(32).fill(7) };
    await saveRaw(id, await blobFor(otherKey, id, PATH, "someone else's text\n"));

    await b.engine.sync();

    expect(b.vault.textOf(PATH)).toBe("mine\n");
    expect(b.engine.status()).toContain(id);
  });

  it("is refused when it names another vault", async () => {
    const a = await syncedDevice(world, { [PATH]: "mine\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B other vault") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    await saveRaw(id, await blobFor({ ...world.keys, vaultId: "another-vault" }, id, PATH, "from another vault\n"));

    await b.engine.sync();

    expect(b.vault.textOf(PATH)).toBe("mine\n");
    expect(b.engine.status()).toContain(id);
  });

  it("is refused when it is under another key number than this device's", async () => {
    const a = await syncedDevice(world, { [PATH]: "mine\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B other kid") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    const head = bodyOf(await world.agents.note(id)).version as number;
    bodyOf(await world.agents.save(id, await blobFor({ ...world.keys, kid: KID + 1 }, id, PATH, "under the next key\n"), { base: head, kid: KID + 1 }));

    await b.engine.sync();

    expect(b.vault.textOf(PATH)).toBe("mine\n");
    expect(b.engine.status()).toContain(id);
  });

  it("is refused when it is cut short, however short", async () => {
    const a = await syncedDevice(world, { [PATH]: "mine\n" });
    const b = await syncedDevice(world, {}, { token: await world.tokenFor(world.user, "device B short") });
    await b.engine.sync();
    const { id } = a.data().notes[PATH];
    await saveRaw(id, Buffer.from("AQAAAAE=", "base64").toString("base64"));

    await b.engine.sync();

    expect(b.vault.textOf(PATH)).toBe("mine\n");
    expect(b.engine.status()).toContain(id);
  });
});

describe("a blob that opens but names a place the vault must not be written to", () => {
  it.each(["/etc/outside.md", "Ideas//double.md", "Ideas/back\\slash.md"])("is refused, named by its id, and not written: %s", async (path) => {
    const b = await syncedDevice(world, {});
    const made = await world.elsewhere.create(path, "should not land\n");

    await b.engine.sync();

    expect(b.vault.texts()).toEqual({});
    expect(b.engine.status()).toContain(made.id);
  });

  it("is passed over without a word when the path is not a note at all, as an attachment or a file in .obsidian is", async () => {
    const b = await syncedDevice(world, {});
    await world.elsewhere.create("../../outside.md", "climbs out\n");
    await world.elsewhere.create(".obsidian/plugins/x/main.js", "code\n");

    await b.engine.sync();

    expect(b.vault.texts()).toEqual({});
    expect(b.engine.status()).toMatch(/last synced/i);
  });
});
