// A save that meets a newer version of the note (Nexus answers 409) keeps both. The agent reads the version Nexus says is current,
// puts its change on top of that text, and saves from it: it never saves over a newer text it has not read. When the two changed the
// same lines nothing is merged, and the agent's text is kept as a second note beside the first. Another writer's save is made in the
// moment between the agent looking at the note and sending its save, the one moment a lock cannot cover.

import { beforeEach, describe, expect, it } from "vitest";
import { makeDevice, nexusNotes, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { AgentVault } from "../src/index";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type Seen, type World } from "./world";

let world: World;
let credentials: AgentCredentials;

beforeEach(async () => {
  world = await openWorld();
  await setUpVault(world);
  credentials = await agentCredentials(world);
});

/** An agent whose first save meets `interference`: it runs just before the first save is sent, as another writer's save would. */
async function agentMet(interference: () => Promise<void>) {
  let met = false;
  const { fetch, seen } = fetchOverNexus({
    before: async (call) => {
      if (!met && call.method === "POST" && call.route === "save") {
        met = true;
        await interference();
      }
    },
  });
  const vault = await AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch, now: () => new Date(2026, 10, 15, 12) });
  return { vault, seen };
}

/** The calls the agent made to one note, in order, as `METHOD route -> status`. */
const about = (seen: Seen[]) => seen.filter((s) => /^(save|note|delete)/.test(s.route)).map((s) => `${s.method} ${s.route.split("&")[0]} -> ${s.status}`);

describe("a save that meets a newer version", () => {
  it("reads the current version and puts its change on top of it, and keeps both changes", async () => {
    const made = await world.elsewhere.create("Projects/plan.md", "one\ntwo\nthree\n");
    const { vault, seen } = await agentMet(async () => {
      await world.elsewhere.update(made.id, "Projects/plan.md", "one\ntwo\nTHREE from the plugin\n");
    });

    const done = await vault.write("Projects/plan.md", "ONE from the agent\ntwo\nthree\n");

    expect(done).toEqual({ path: "Projects/plan.md", version: 3, saved: true, merged: true, duplicate: false });
    expect(await nexusTexts(world), "both edits are in the text").toEqual({ "Projects/plan.md": "ONE from the agent\ntwo\nTHREE from the plugin\n" });
    // The order of what the agent asked Nexus: a save from version 1 (refused), a read of version 2, a save from version 2.
    expect(about(seen)).toEqual(["POST save -> 409", `GET note?id=${made.id} -> 200`, "POST save -> 200"]);
    const saves = seen.filter((s) => s.route === "save");
    expect(saves.map((s) => s.body.base), "the first save started from 1, the second from the version it had read").toEqual([1, 2]);
    const read = seen.find((s) => s.route.startsWith("note"))!;
    expect(read.route).toContain("version=2");
    expect(seen.indexOf(read), "the read of the newer version came before the second save").toBeLessThan(seen.indexOf(saves[1]!));
    // Nothing was overwritten: the plugin's version is still in the note's history.
    const history = (await nexusNotes(world))[made.id]!;
    expect(history.version).toBe(3);
    vault.close();
  });

  it("is seen by the plugin as one note with both edits", async () => {
    const made = await world.elsewhere.create("Projects/plan.md", "one\ntwo\nthree\n");
    const { vault } = await agentMet(async () => {
      await world.elsewhere.update(made.id, "Projects/plan.md", "one\ntwo\nTHREE\n");
    });
    await vault.write("Projects/plan.md", "ONE\ntwo\nthree\n");
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(device.vault.texts()).toEqual({ "Projects/plan.md": "ONE\ntwo\nTHREE\n" });
    vault.close();
  });

  it("keeps the agent's text as a second note, and the first as it is, when both changed the same lines", async () => {
    const made = await world.elsewhere.create("Projects/plan.md", "one\ntwo\nthree\n");
    const { vault, seen } = await agentMet(async () => {
      await world.elsewhere.update(made.id, "Projects/plan.md", "one\nTWO from the plugin\nthree\n");
    });

    const done = await vault.write("Projects/plan.md", "one\nTWO from the agent\nthree\n");

    expect(done).toEqual({ path: "Projects/plan (duplicate agent 2026-11-15).md", version: 1, saved: true, merged: false, duplicate: true });
    expect(await nexusTexts(world), "the newer text is untouched, and the agent's is kept beside it").toEqual({
      "Projects/plan.md": "one\nTWO from the plugin\nthree\n",
      "Projects/plan (duplicate agent 2026-11-15).md": "one\nTWO from the agent\nthree\n",
    });
    const saves = seen.filter((s) => s.route === "save");
    expect(saves.map((s) => [s.body.base, s.status]), "the refused save, then a new note: nothing was saved over the newer text").toEqual([[1, 409], [0, 200]]);
    expect(saves[1]!.body.id, "a new note's id, not the first note's").not.toBe(made.id);
    expect(await vault.list()).toEqual(["Projects/plan (duplicate agent 2026-11-15).md", "Projects/plan.md"]);
    // The plugin takes the duplicate as an ordinary note.
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(Object.keys(device.vault.texts()).sort()).toEqual(["Projects/plan (duplicate agent 2026-11-15).md", "Projects/plan.md"]);
    vault.close();
  });

  it("keeps both when another writer made a new note at the same path at the same moment: Nexus holds two notes, and the plugin sorts them out as it does for two devices", async () => {
    const { vault } = await agentMet(async () => {
      await world.elsewhere.create("Inbox/new.md", "the other writer's first text\n");
    });
    // Nexus cannot tell two new notes at one path apart (their ids differ), so the agent's save goes through as a note of its own.
    expect(await vault.write("Inbox/new.md", "the agent's first text\n")).toMatchObject({ path: "Inbox/new.md", saved: true, duplicate: false });
    expect(Object.values(await nexusNotes(world)).map((note) => note.text).sort()).toEqual(["the agent's first text\n", "the other writer's first text\n"]);
    const device = await makeDevice(world, { unlock: new TestUnlock(world.keys) });
    await device.engine.sync();
    expect(Object.values(device.vault.texts()).sort(), "the plugin's vault holds both texts").toEqual(["the agent's first text\n", "the other writer's first text\n"]);
    vault.close();
  });

  it("writes the note again as a new one when the other writer deleted it, since nothing newer is lost", async () => {
    const made = await world.elsewhere.create("Old/note.md", "first\n");
    const { vault } = await agentMet(async () => {
      await world.elsewhere.remove(made.id);
    });
    expect(await vault.write("Old/note.md", "first, and more\n")).toMatchObject({ path: "Old/note.md", saved: true, duplicate: false });
    expect(await nexusTexts(world)).toEqual({ "Old/note.md": "first, and more\n" });
    vault.close();
  });

  it("is not a second save when the other writer saved exactly what the agent meant to", async () => {
    const made = await world.elsewhere.create("Same/text.md", "before\n");
    const { vault, seen } = await agentMet(async () => {
      await world.elsewhere.update(made.id, "Same/text.md", "after\n");
    });
    expect(await vault.write("Same/text.md", "after\n")).toMatchObject({ saved: false, version: 2 });
    expect(seen.filter((s) => s.route === "save").map((s) => s.status), "only the one refused save").toEqual([409]);
    vault.close();
  });

  it("does not delete a note that changed since it was looked at, and says so", async () => {
    const made = await world.elsewhere.create("Keep/me.md", "keep this\n");
    let changedNow = false;
    const racing = fetchOverNexus({
      before: async (call) => {
        if (!changedNow && call.method === "POST" && call.route === "delete") {
          changedNow = true;
          await world.elsewhere.update(made.id, "Keep/me.md", "keep this, newer\n");
        }
      },
    });
    const other = await AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch: racing.fetch });
    await expect(other.remove("Keep/me.md")).rejects.toMatchObject({ name: "AgentError", code: "changed" });
    expect(await nexusTexts(world), "the newer text is still there").toEqual({ "Keep/me.md": "keep this, newer\n" });
    expect(racing.seen.filter((s) => s.route === "delete").map((s) => s.status)).toEqual([409]);
    other.close();
  });

  it("gives up with a plain error, and writes nothing more, when the note keeps changing under it", async () => {
    const made = await world.elsewhere.create("Busy/note.md", "a\nb\nc\n");
    let appended = "";
    const { fetch, seen } = fetchOverNexus({
      before: async (call) => {
        if (call.method === "POST" && call.route === "save") {
          appended += `line ${appended.length}\n`;
          await world.elsewhere.update(made.id, "Busy/note.md", `a\nb\nc\n${appended}`);
        }
      },
    });
    const vault = await AgentVault.open({ address: ADDRESS, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch });
    await expect(vault.write("Busy/note.md", "A from the agent\nb\nc\n")).rejects.toMatchObject({ name: "AgentError", code: "changed" });
    expect(seen.filter((s) => s.route === "save").every((s) => s.status === 409), "every save of the agent's was refused").toBe(true);
    expect((await nexusTexts(world))["Busy/note.md"], "the other writer's last text stands").toBe(`a\nb\nc\n${appended}`);
    vault.close();
  });
});
