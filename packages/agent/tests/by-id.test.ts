// Writing into a vault without opening it. A writer that keeps its own note ids (a transcript writer keeps one on each of its rows) makes
// a note, reads it and updates it by its id, and each call sends or reads that ONE note: it never asks Nexus for the vault's notes, so
// the size of the vault costs it nothing. Every call goes to the server's own routes (world.ts), and `seen` is what the agent asked.

import { generateDeviceKeyPair, generateVaultKey, sealApproval } from "@nexus/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { blobFor, bodyOf, makeDevice, nexusNotes, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { encodeBase64 } from "../src/base64";
import { AgentVault, type FetchLike } from "../src/index";
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

/** The routes that look at more than one note. A call that goes by id must never use them (but for the small page `connect` asks for, to see that the key opens a note). */
const WHOLE_VAULT = /^(changes|heads|list|history)/;

describe("connecting without opening the vault", () => {
  it("opens the approval and asks which vault the server holds, and for a few notes only to see that the key opens one: in a vault with no note, nothing more", async () => {
    const { vault, seen } = await connect();
    expect(vault.vaultId).toBe(world.keys.vaultId);
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET heads -> 200"]);
    expect(seen[1]!.route).toBe("heads?limit=10");
    vault.close();
  });

  it("stops at the first note that opens with the key: a vault of any size costs one small page", async () => {
    for (let n = 0; n < 25; n++) await world.elsewhere.create(`Other/note-${n}.md`, `note ${n}\n`);
    const { vault, seen } = await connect();
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET heads -> 200"]);
    vault.close();
  });

  it("refuses a key that opens none of the vault's notes, before anything is written under it, and does not take a deleted note for one that should open", async () => {
    await world.elsewhere.create("Daily/a.md", "a\n");
    const gone = await world.elsewhere.create("Daily/gone.md", "gone\n");
    await world.elsewhere.remove(gone.id);
    const { fetch, seen } = fetchOverNexus();
    const wrong = { ...credentials, ...(await approvalFor(await generateVaultKey(), world.keys.vaultId)), fetch };
    await expect(AgentVault.connect(wrong)).rejects.toMatchObject({ name: "AgentError", code: "wrong-key" });
    expect(seen.filter((s) => s.method === "POST"), "nothing was written").toEqual([]);

    // A vault whose only notes are deleted ones has no note to show a wrong key with.
    const bare = await openWorld();
    await setUpVault(bare);
    const only = await bare.elsewhere.create("Daily/only.md", "x\n");
    await bare.elsewhere.remove(only.id);
    const fresh = await agentCredentials(bare);
    const again = fetchOverNexus();
    const connected = await AgentVault.connect({ ...fresh, ...(await approvalFor(await generateVaultKey(), bare.keys.vaultId)), fetch: again.fetch });
    connected.close();
  });

  it("looks past notes it cannot open to one it can, a page at a time, and does not take them for a wrong key", async () => {
    // Twelve notes made under another key come first, so the first page of 10 holds no note that opens; the 13th does.
    const foreign = { vaultKey: await generateVaultKey(), vaultId: world.keys.vaultId, kid: world.keys.kid };
    for (let n = 0; n < 12; n++) await world.agents.save(`foreign-${n}`, await blobFor(foreign, `foreign-${n}`, `Foreign/${n}.md`, "x\n"), { base: 0, kid: foreign.kid });
    await world.elsewhere.create("Daily/mine.md", "mine\n");
    const { vault, seen } = await connect();
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET heads -> 200", "GET heads -> 200"]);
    vault.close();
  });

  it("asks the changes feed instead, in the same way, of a server that has no heads route", async () => {
    await world.elsewhere.create("Daily/a.md", "a\n");
    const { fetch, seen } = fetchOverNexus();
    const older: typeof fetch = async (url, init) => (/\/heads(\?|$)/.test(url) ? { status: 404, text: async () => JSON.stringify({ error: "Nexus has no such route." }) } : fetch(url, init));
    const vault = await AgentVault.connect({ ...credentials, fetch: older });
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET changes -> 200"]);
    const wrong = { ...credentials, ...(await approvalFor(await generateVaultKey(), world.keys.vaultId)), fetch: older };
    await expect(AgentVault.connect(wrong)).rejects.toMatchObject({ code: "wrong-key" });
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
    expect(asked(seen), "the vault id, a look for a note that opens, and the one save").toEqual(["GET wraps -> 200", "GET heads -> 200", "POST save -> 200"]);
    expect(seen[2]!.body).toMatchObject({ id: made.id, base: 0 });

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

  it("says a note it cannot open is unreadable: one made under another key, or at a path the plugin would refuse", async () => {
    const mine = await world.elsewhere.create("Ideas/mine.md", "this key opens it\n");
    const refused = await world.elsewhere.create("../outside.md", "a path the plugin refuses\n");
    const foreign = { vaultKey: await generateVaultKey(), vaultId: world.keys.vaultId, kid: world.keys.kid };
    await world.agents.save("foreign-note", await blobFor(foreign, "foreign-note", "Ideas/foreign.md", "sealed with another key\n"), { base: 0, kid: foreign.kid });

    const { vault } = await connect();
    expect(await vault.readNote(mine.id)).toMatchObject({ path: "Ideas/mine.md", version: 1 });
    for (const id of ["foreign-note", refused.id]) {
      await expect(vault.readNote(id), id).rejects.toMatchObject({ code: "unreadable" });
      await expect(vault.updateNote(id, 1, "x"), id).rejects.toMatchObject({ code: "unreadable" });
    }
    vault.close();
  });
});

describe("a note made again after its answer was lost", () => {
  const PATH = "Agent/First.md";
  const ID = "ep-123";

  /** A `fetch` that sends the first save to Nexus, so Nexus keeps it, and then drops the answer, as a timeout or a Worker cut off mid-request does. */
  const losingTheFirstAnswer = (inner: FetchLike): { fetch: FetchLike; lost: () => number } => {
    let lost = 0;
    const fetch: FetchLike = async (url, init) => {
      const answer = await inner(url, init);
      if (init.method === "POST" && url.endsWith("/save") && lost === 0) {
        lost++;
        throw new Error("the connection was cut");
      }
      return answer;
    };
    return { fetch, lost: () => lost };
  };

  const connectLosing = async () => {
    const world = fetchOverNexus();
    const losing = losingTheFirstAnswer(world.fetch);
    const vault = await AgentVault.connect({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch: losing.fetch });
    return { vault, seen: world.seen, lost: losing.lost };
  };

  it("makes the note at the id it is given, with one save", async () => {
    const { vault, seen } = await connect();
    expect(await vault.createNote(PATH, "# First\n", { id: ID })).toEqual({ id: ID, path: PATH, version: 1 });
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET heads -> 200", "POST save -> 200"]);
    expect(seen[2]!.body).toMatchObject({ id: ID, base: 0 });
    expect(await nexusNotes(world)).toEqual({ [ID]: { path: PATH, text: "# First\n", version: 1 } });
    vault.close();
  });

  it("answers the note that is there, version 1, when the same id and text are made again after the answer was lost, and saves nothing", async () => {
    const { vault, seen, lost } = await connectLosing();
    await expect(vault.createNote(PATH, "# First\n", { id: ID })).rejects.toMatchObject({ name: "AgentError", code: "unreachable" });
    expect(lost(), "the answer was dropped after Nexus had kept the note").toBe(1);
    expect(await nexusNotes(world)).toEqual({ [ID]: { path: PATH, text: "# First\n", version: 1 } });

    const before = seen.length;
    expect(await vault.createNote(PATH, "# First\n", { id: ID })).toEqual({ id: ID, path: PATH, version: 1 });
    expect(asked(seen.slice(before)), "the save is answered 409, the note is read once, and nothing is saved").toEqual(["POST save -> 409", "GET note -> 200"]);

    expect(await nexusNotes(world), "one note, still at version 1").toEqual({ [ID]: { path: PATH, text: "# First\n", version: 1 } });
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.textOf(PATH)).toBe("# First\n");
    expect((await device.vault.files()).filter((file) => file.endsWith(".md"))).toEqual([PATH]);

    // The answer can be used as any other: the note is updated from the version it tells.
    expect(await vault.updateNote(ID, 1, "# First\n\nMore.\n")).toEqual({ result: "saved", id: ID, path: PATH, version: 2 });
    vault.close();
  });

  it("refuses the same id with another text, plainly, and changes nothing", async () => {
    const { vault, seen } = await connect();
    await vault.createNote(PATH, "# First\n", { id: ID });
    const before = seen.length;
    const refused = await vault.createNote(PATH, "# Something else\n", { id: ID }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: "AgentError", code: "id-taken" });
    expect((refused as Error).message).toMatch(/already (a|the) note|already there|read it/i);
    expect((refused as Error).message, "the text is never repeated in a message").not.toContain("Something else");
    expect(asked(seen.slice(before)).filter((line) => line.includes("-> 200") && line.startsWith("POST"))).toEqual([]);
    expect(await nexusNotes(world)).toEqual({ [ID]: { path: PATH, text: "# First\n", version: 1 } });
    vault.close();
  });

  it("refuses the same id and text at another path, which is another note, and changes nothing", async () => {
    const { vault } = await connect();
    await vault.createNote(PATH, "# First\n", { id: ID });
    await expect(vault.createNote("Agent/Other.md", "# First\n", { id: ID })).rejects.toMatchObject({ code: "id-taken" });
    expect(await nexusNotes(world)).toEqual({ [ID]: { path: PATH, text: "# First\n", version: 1 } });
    vault.close();
  });

  it("answers the version the note is at when it has moved on and still says the same, and refuses when it says something else", async () => {
    const { vault } = await connect();
    await vault.createNote(PATH, "# First\n", { id: ID });
    expect(await vault.updateNote(ID, 1, "# Changed\n")).toMatchObject({ result: "saved", version: 2 });
    await expect(vault.createNote(PATH, "# First\n", { id: ID }), "the text it was made with is not what is there now").rejects.toMatchObject({ code: "id-taken" });
    expect(await vault.createNote(PATH, "# Changed\n", { id: ID })).toEqual({ id: ID, path: PATH, version: 2 });
    expect(await nexusNotes(world)).toEqual({ [ID]: { path: PATH, text: "# Changed\n", version: 2 } });
    vault.close();
  });

  it("refuses an id whose note was deleted, and a note it cannot open, and never brings a note back", async () => {
    await world.elsewhere.create("Ideas/mine.md", "this key opens it\n"); // so `connect` finds a note the key opens
    const made = await world.elsewhere.create("Ideas/gone.md", "gone\n");
    await world.elsewhere.remove(made.id);
    const foreign = { vaultKey: await generateVaultKey(), vaultId: world.keys.vaultId, kid: world.keys.kid };
    await world.agents.save("foreign-note", await blobFor(foreign, "foreign-note", "Ideas/foreign.md", "sealed with another key\n"), { base: 0, kid: foreign.kid });
    const { vault } = await connect();
    await expect(vault.createNote("Ideas/gone.md", "gone\n", { id: made.id })).rejects.toMatchObject({ code: "id-taken" });
    await expect(vault.createNote("Ideas/foreign.md", "sealed with another key\n", { id: "foreign-note" })).rejects.toMatchObject({ code: "id-taken" });
    const held = (bodyOf(await world.owner.list()).notes as Array<{ id: string }>).map((note) => note.id);
    expect(held, "the deleted note is still deleted, and the foreign one was not touched").toHaveLength(2);
    expect(held).toContain("foreign-note");
    expect(held).not.toContain(made.id);
    expect(bodyOf(await world.owner.note("foreign-note")).version).toBe(1);
    expect((await world.owner.note(made.id)).status, "Nexus still says it was deleted").toBe(404);
    vault.close();
  });

  it("refuses an id that is not a note id before anything is sent, and leaves a call with no id as it was: a new random id each time", async () => {
    const { vault, seen } = await connect();
    const sent = seen.length;
    for (const id of ["", "../etc/passwd", "has space", "x".repeat(129), 7 as unknown as string]) {
      await expect(vault.createNote(PATH, "x", { id }), String(id)).rejects.toMatchObject({ code: "bad-settings" });
    }
    expect(seen.length, "those were refused before anything was sent").toBe(sent);

    const first = await vault.createNote("Agent/a.md", "a\n");
    const second = await vault.createNote("Agent/a.md", "a\n", {});
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.id, "no id given, so a second note").not.toBe(first.id);
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
    expect(seen.filter((s) => WHOLE_VAULT.test(s.route) && !s.route.startsWith("heads?limit=10")), "no call asked for more than one note").toEqual([]);
    expect(asked(seen)).toEqual(["GET wraps -> 200", "GET heads -> 200", "POST save -> 200", "POST save -> 200", "POST save -> 409", "GET note -> 200"]);
    vault.close();
  });

  it("looks at the vault when a call by path needs it, once, and sees the notes made by id", async () => {
    await world.elsewhere.create("Other/a.md", "a\n");
    const { vault, seen } = await connect();
    const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n");
    expect(seen.filter((s) => WHOLE_VAULT.test(s.route) && !s.route.startsWith("heads?limit=10"))).toEqual([]);
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
