// Writing into a vault without opening it. A writer that keeps its own note ids (a transcript writer keeps one on each of its rows) makes
// a note, reads it and updates it by its id, and each call sends or reads that ONE note: it never asks Nexus for the vault's notes, so
// the size of the vault costs it nothing. Every call goes to the server's own routes (world.ts), and `seen` is what the agent asked.

import { generateDeviceKeyPair, generateVaultKey, sealApproval } from "@nexus/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDevice, nexusNotes, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { encodeBase64 } from "../src/base64";
import { AgentVault } from "../src/index";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type Seen, type World } from "./world";

let world: World;
let credentials: AgentCredentials;

beforeEach(async () => {
  world = await openWorld();
  await setUpVault(world);
  credentials = await agentCredentials(world);
});

const connect = async () => {
  const { fetch, seen } = fetchOverNexus();
  const vault = await AgentVault.connect({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch });
  return { vault, seen };
};

/** What was asked, as `GET changes`, `POST save -> 200`: the route's first word, without its query. */
const asked = (seen: Seen[]) => seen.map((s) => `${s.method} ${s.route.split("?")[0]} -> ${s.status}`);

/** The routes that look at more than one note. A call that goes by id must never use them. */
const WHOLE_VAULT = /^(changes|heads|list|history)/;

describe("connecting without opening the vault", () => {
  it("opens the approval and asks which vault the server holds, and asks for no note", async () => {
    const { vault, seen } = await connect();
    expect(vault.vaultId).toBe(world.keys.vaultId);
    expect(asked(seen)).toEqual(["GET wraps -> 200"]);
    vault.close();
  });

  it("refuses what open refuses before it reads a note: a wrong key, an approval for another vault, and no sign-in token", async () => {
    const { fetch } = fetchOverNexus();
    await expect(AgentVault.connect({ ...credentials, privateKey: credentials.publicKey, fetch })).rejects.toMatchObject({ name: "AgentError", code: "bad-approval" });
    await expect(AgentVault.connect({ ...credentials, token: "", fetch })).rejects.toMatchObject({ code: "bad-settings" });
    await expect(AgentVault.connect({ ...credentials, ...(await approvalFor(world.keys.vaultKey, "another-vault")), fetch })).rejects.toMatchObject({ code: "wrong-vault" });
  });
});

/** A new key pair for an agent and an approval sealed to it, for a vault key and vault id of the test's choosing. */
async function approvalFor(vaultKey: Uint8Array, vaultId: string): Promise<{ privateKey: string; approval: string }> {
  const pair = await generateDeviceKeyPair();
  return { privateKey: encodeBase64(pair.privateKey), approval: encodeBase64(await sealApproval(pair.publicKey, vaultKey, { vaultId, kid: world.keys.kid })) };
}

describe("a note made, updated and read by its id", () => {
  it("makes a note at a path with one save, tells its id and version, and the plugin reads it", async () => {
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n");
    expect(made).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), path: "Agent/2026-11-15 First.md", version: 1 });
    expect(asked(seen), "the vault id, and the one save").toEqual(["GET wraps -> 200", "POST save -> 200"]);
    expect(seen[1]!.body).toMatchObject({ id: made.id, base: 0 });

    expect(await nexusTexts(world)).toEqual({ "Agent/2026-11-15 First.md": "# First\n" });
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.textOf("Agent/2026-11-15 First.md")).toBe("# First\n");
    vault.close();
  });

  it("updates it at its version, and an update from the old version is answered changed-since and changes nothing", async () => {
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n");

    const updated = await vault.updateNote(made.id, made.version, "# First\n\nMore.\n");
    expect(updated).toEqual({ result: "saved", id: made.id, path: made.path, version: 2 });

    const before = seen.length;
    const stale = await vault.updateNote(made.id, made.version, "# Stale\n");
    expect(stale).toEqual({ result: "changed-since", id: made.id, current: 2 });
    expect(asked(seen.slice(before)), "one save, refused").toEqual(["POST save -> 409"]);

    const held = (await nexusNotes(world))[made.id]!;
    expect(held, "the second text is still there, and the stale one left no version").toEqual({ path: made.path, text: "# First\n\nMore.\n", version: 2 });
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.textOf("Agent/2026-11-15 First.md")).toBe("# First\n\nMore.\n");
    vault.close();
  });

  it("goes on from the version each save answers, so a writer can append to its note again and again", async () => {
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/transcript.md", "line 1\n");
    let version = made.version;
    let text = "line 1\n";
    for (let line = 2; line <= 6; line++) {
      text += `line ${line}\n`;
      const done = await vault.updateNote(made.id, version, text);
      expect(done).toMatchObject({ result: "saved", version: version + 1 });
      version += 1;
    }
    expect((await nexusNotes(world))[made.id]).toMatchObject({ text, version: 6 });
    expect(seen.filter((s) => s.route.startsWith("note")), "the path was remembered, so no note was read to update it").toEqual([]);
    vault.close();
  });

  it("reads the note by its id: its path, its version and its text, with one read of that note", async () => {
    const made = await world.elsewhere.create("Ideas/shared.md", "from a device\n");
    await world.elsewhere.update(made.id, "Ideas/shared.md", "from a device, edited\n");
    const { vault, seen } = await connect();
    const before = seen.length;
    expect(await vault.readNote(made.id)).toEqual({ id: made.id, path: "Ideas/shared.md", version: 2, text: "from a device, edited\n" });
    expect(asked(seen.slice(before))).toEqual(["GET note -> 200"]);
    vault.close();
  });

  it("updates a note another writer made: it reads that version once to learn the path, then saves", async () => {
    const made = await world.elsewhere.create("Ideas/shared.md", "from a device\n");
    const { vault, seen } = await connect();
    const before = seen.length;
    expect(await vault.updateNote(made.id, made.version, "from a device, and the agent\n")).toEqual({ result: "saved", id: made.id, path: "Ideas/shared.md", version: 2 });
    expect(asked(seen.slice(before))).toEqual(["GET note -> 200", "POST save -> 200"]);
    expect(seen[before]!.route).toContain("version=1");
    expect((await nexusNotes(world))[made.id]).toMatchObject({ path: "Ideas/shared.md", text: "from a device, and the agent\n", version: 2 });
    vault.close();
  });

  it("answers changed-since for a version a plugin has moved past, and for a note that was deleted, and never brings it back", async () => {
    const made = await world.elsewhere.create("Ideas/shared.md", "from a device\n");
    await world.elsewhere.update(made.id, "Ideas/shared.md", "edited on the device\n");
    const { vault } = await connect();
    expect(await vault.updateNote(made.id, 1, "the agent's, from the old version\n")).toEqual({ result: "changed-since", id: made.id, current: 2 });

    await world.elsewhere.remove(made.id);
    expect(await vault.updateNote(made.id, 2, "the agent's, after the delete\n")).toEqual({ result: "changed-since", id: made.id, current: 3 });
    expect(await nexusNotes(world), "the note is still deleted").toEqual({});
    await expect(vault.readNote(made.id)).rejects.toMatchObject({ code: "not-found" });
    vault.close();
  });

  it("refuses a note that is not there, an id that is not one, a version that is not one, and a path the plugin would refuse, and sends nothing", async () => {
    const { vault, seen } = await connect();
    await expect(vault.readNote("no-such-note")).rejects.toMatchObject({ code: "not-found" });
    await expect(vault.updateNote("no-such-note", 1, "x")).rejects.toMatchObject({ code: "not-found" });
    const sent = seen.length;
    await expect(vault.readNote("../etc/passwd")).rejects.toMatchObject({ code: "bad-settings" });
    await expect(vault.readNote("")).rejects.toMatchObject({ code: "bad-settings" });
    await expect(vault.updateNote("fine-id", 0, "x")).rejects.toMatchObject({ code: "bad-settings" });
    await expect(vault.updateNote("fine-id", 1.5, "x")).rejects.toMatchObject({ code: "bad-settings" });
    await expect(vault.updateNote("fine-id", 1, 7 as unknown as string)).rejects.toMatchObject({ code: "bad-settings" });
    await expect(vault.createNote("../outside.md", "x")).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(vault.createNote(".hidden/a.md", "x")).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(vault.createNote("a.md", 7 as unknown as string)).rejects.toMatchObject({ code: "bad-settings" });
    expect(seen.length, "those were refused before anything was sent").toBe(sent);
    vault.close();
  });

  it("says a note it cannot open is unreadable, and does not take a note's text for another vault's", async () => {
    const made = await world.elsewhere.create("Ideas/shared.md", "from a device\n");
    const { fetch } = fetchOverNexus();
    // A vault key of its own that opens none of the notes: the approval is for the vault the server holds, with another key.
    const vault = await AgentVault.connect({ ...credentials, ...(await approvalFor(await generateVaultKey(), world.keys.vaultId)), fetch });
    await expect(vault.readNote(made.id)).rejects.toMatchObject({ code: "unreadable" });
    await expect(vault.updateNote(made.id, 1, "x")).rejects.toMatchObject({ code: "unreadable" });
    vault.close();
  });
});

describe("a vault with many notes", () => {
  it("costs a call by id nothing: whatever the vault holds, it asks for the one note", async () => {
    for (let n = 0; n < 40; n++) await world.elsewhere.create(`Other/note-${n}.md`, `note ${n}\n`);
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n");
    await vault.updateNote(made.id, 1, "# First\n\nMore.\n");
    await vault.updateNote(made.id, 1, "# Stale\n");
    await vault.readNote(made.id);
    expect(seen.filter((s) => WHOLE_VAULT.test(s.route)), "no call asked for more than one note").toEqual([]);
    expect(asked(seen)).toEqual(["GET wraps -> 200", "POST save -> 200", "POST save -> 200", "POST save -> 409", "GET note -> 200"]);
    vault.close();
  });

  it("looks at the vault when a call by path needs it, once, and sees the notes made by id", async () => {
    await world.elsewhere.create("Other/a.md", "a\n");
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n");
    expect(seen.filter((s) => WHOLE_VAULT.test(s.route))).toEqual([]);
    expect(await vault.list()).toEqual(["Agent/2026-11-15 First.md", "Other/a.md"]);
    expect(await vault.listNotes()).toEqual([
      { path: "Agent/2026-11-15 First.md", id: made.id, version: 1 },
      { path: "Other/a.md", id: expect.any(String), version: 1 },
    ]);
    expect(await vault.read("Agent/2026-11-15 First.md")).toBe("# First\n");
    vault.close();
  });

  it("refuses every call once it is closed", async () => {
    const { vault } = await connect();
    vault.close();
    await expect(vault.createNote("a.md", "x")).rejects.toMatchObject({ code: "closed" });
    await expect(vault.readNote("fine-id")).rejects.toMatchObject({ code: "closed" });
    await expect(vault.updateNote("fine-id", 1, "x")).rejects.toMatchObject({ code: "closed" });
  });
});
