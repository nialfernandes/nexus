// What other writers do in Nexus comes down to the vault from the changes feed, each change once, however many
// times and in however many pages the plugin asks. A save writes the note, a save under a new path renames it (the path is inside
// the encrypted record, and the id stays) and a delete removes it. What the plugin's own writes and renames and removals cause in
// Obsidian is never sent back, and what the plugin itself sent comes back in the feed as a no-op. Against the in-memory Nexus
// (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_PAUSE, blobFor, bodyOf, emptyNexus, fakeTimers, forbidFetch, makeDevice, nexusTexts, openWorld, sentNote, syncedDevice, type Device, type World,
} from "./world";

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

/** Where the log stands, so a test can ask what happened after this point. */
const mark = (device: Device): number => device.log.timeline.length;
const vaultChangesSince = (device: Device, from: number) =>
  device.log.timeline.slice(from).filter((s) => s.kind === "write" || s.kind === "rename" || s.kind === "remove");
const requestsSince = (device: Device, from: number) =>
  device.log.timeline.slice(from).flatMap((s) => (s.kind === "request" ? [s.seen] : []));

describe("changes made in Nexus", () => {
  it("come down as writes, renames and removals, and the vault ends up as Nexus is", async () => {
    const device = await syncedDevice(world);
    const moved = await world.elsewhere.create("Agents/new.md", "first\n");
    await world.elsewhere.update(moved.id, "Agents/new.md", "second\n");
    await world.elsewhere.update(moved.id, "Agents/renamed.md", "second\n");
    const temp = await world.elsewhere.create("Agents/temp.md", "temp\n");
    await world.elsewhere.remove(temp.id);
    const other = await world.elsewhere.create("Agents/other.md", "other\n");
    await world.elsewhere.update(other.id, "Agents/other.md", "other, edited\n");

    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Agents/renamed.md": "second\n", "Agents/other.md": "other, edited\n" });
    const { notes } = device.data();
    expect(notes["Agents/renamed.md"], "the rename was the note's third version").toMatchObject({ id: moved.id, version: 3 });
    expect(notes["Agents/other.md"]).toMatchObject({ id: other.id, version: 2 });
    expect(notes["Agents/new.md"], "a note that moved is no longer stored at its old path").toBeUndefined();
    expect(notes["Agents/temp.md"], "nor is a note that was deleted").toBeUndefined();
    expect(device.log.to("POST save"), "bringing changes down sends nothing up").toEqual([]);
  });

  it("are taken once: asking again, in this run or after a restart, applies nothing twice", async () => {
    const device = await syncedDevice(world);
    const a = await world.elsewhere.create("Once/a.md", "a\n");
    await world.elsewhere.update(a.id, "Once/b.md", "a\n");
    const c = await world.elsewhere.create("Once/c.md", "c\n");
    await world.elsewhere.remove(c.id);

    await device.engine.sync();
    expect(device.vault.texts()).toEqual({ "Once/b.md": "a\n" });
    const cursor = device.data().cursor;
    expect(cursor).not.toBeNull();
    const lastFeedAnswer = device.log.to("GET changes").at(-1)!.answer;
    expect(cursor, "the stored cursor is the one the feed gave last").toBe(lastFeedAnswer.next);

    const again = mark(device);
    await device.engine.sync();
    expect(vaultChangesSince(device, again), "the second pull changes nothing").toEqual([]);
    const askedAgain = requestsSince(device, again).find((r) => r.route === "changes");
    expect(askedAgain?.query.after, "and it starts from the stored cursor, not from the start").toBe(cursor);
    expect(device.data().cursor).toBe(cursor);

    const restarted = await makeDevice(world, { vault: device.vault, from: device.data(), unlock: device.unlock });
    await restarted.engine.sync();
    expect(vaultChangesSince(restarted, 0), "a restart carries on from the stored cursor").toEqual([]);
    expect(restarted.log.to("GET changes")[0].query.after).toBe(cursor);

    await world.elsewhere.create("Once/d.md", "d\n");
    await restarted.engine.sync();
    expect(vaultChangesSince(restarted, 0), "and picks up only what is new").toEqual([{ kind: "write", path: "Once/d.md", text: "d\n" }]);
  });

  it("come down whole when there are more of them than one page of the feed holds", async () => {
    const device = await syncedDevice(world);
    const paths: string[] = [];
    for (let batch = 0; batch < 52; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const path = `Bulk/n${String(batch * 10 + i).padStart(3, "0")}.md`;
          paths.push(path);
          await world.elsewhere.create(path, `note ${path}\n`);
        }),
      );
    }
    expect(paths.length, "more changes than the 500 one page of the feed holds").toBeGreaterThan(500);

    await device.engine.sync();

    expect(device.log.to("GET changes").length, "the feed was read in more than one page").toBeGreaterThanOrEqual(3);
    const expected = Object.fromEntries(paths.map((p) => [p, `note ${p}\n`]));
    expect(device.vault.texts()).toEqual(expected);
    const writes = vaultChangesSince(device, 0).map((s) => (s as { path: string }).path);
    expect(writes.sort(), "each note is written once, none missed at a page's edge, none taken twice").toEqual([...paths].sort());

    const again = mark(device);
    await device.engine.sync();
    expect(vaultChangesSince(device, again)).toEqual([]);
  }, 90_000);

  it("do not come back to Nexus as the plugin's own events", async () => {
    const device = await syncedDevice(world, { "Echo/old.md": "old\n", "Echo/gone.md": "gone\n", "Echo/keep.md": "keep\n" });
    const { notes } = device.data();
    await world.elsewhere.update(notes["Echo/keep.md"].id, "Echo/keep.md", "keep, edited elsewhere\n");
    await world.elsewhere.update(notes["Echo/old.md"].id, "Echo/new.md", "old\n");
    await world.elsewhere.remove(notes["Echo/gone.md"].id);

    await device.engine.sync();
    expect(device.vault.texts()).toEqual({ "Echo/keep.md": "keep, edited elsewhere\n", "Echo/new.md": "old\n" });

    // Obsidian reports the plugin's own changes to the plugin as events. Replay them as it would.
    fakeTimers();
    const quietFrom = mark(device);
    for (const step of vaultChangesSince(device, 0)) {
      if (step.kind === "write") device.engine.edited(step.path);
      if (step.kind === "rename") await device.engine.renamed(step.path, step.to);
      if (step.kind === "remove") await device.engine.deleted(step.path);
    }
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);

    expect(requestsSince(device, quietFrom), "none of it is sent to Nexus").toEqual([]);
    expect(await nexusTexts(world)).toEqual({ "Echo/keep.md": "keep, edited elsewhere\n", "Echo/new.md": "old\n" });
  });

  it("end as the last version says when a note was deleted and then saved again under the same id", async () => {
    const device = await syncedDevice(world);
    const back = await world.elsewhere.create("Back/n.md", "first life\n");
    await world.elsewhere.remove(back.id); // version 2 is the delete
    bodyOf(await world.agents.save(back.id, await blobFor(world.keys, back.id, "Back/n.md", "second life\n"), { base: 2 }));

    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Back/n.md": "second life\n" });
    expect(device.data().notes["Back/n.md"]).toMatchObject({ id: back.id, version: 3 });

    await world.elsewhere.remove(back.id);
    await device.engine.sync();
    expect(device.vault.texts(), "and a later delete removes it").toEqual({});
  });

  it("never overwrite an edit that has not gone up yet: the two edits are merged", async () => {
    const first = await world.elsewhere.create("Race/n.md", "one\ntwo\n");
    const device = await syncedDevice(world, { "Race/n.md": "one\ntwo\n" });
    // The person changes the second line; before it goes up, another device changes the first line.
    device.vault.type("Race/n.md", "one\nTWO\n");
    fakeTimers();
    device.engine.edited("Race/n.md");
    await world.elsewhere.update(first.id, "Race/n.md", "ONE\ntwo\n");

    await device.engine.sync();

    expect(device.vault.textOf("Race/n.md"), "both edits are in the note").toBe("ONE\nTWO\n");
    expect(await nexusTexts(world)).toEqual({ "Race/n.md": "ONE\nTWO\n" });
    expect(device.notices).toEqual([]);
  });
});

describe("changes made in the vault", () => {
  it("become a new version under a new path and a delete in Nexus, and what comes back in the feed is a no-op", async () => {
    const device = await syncedDevice(world, { "Mine/a.md": "a\n", "Mine/b.md": "b\n", "Mine/c.md": "c\n" });
    const ids = Object.fromEntries(Object.entries(device.data().notes).map(([path, note]) => [path, note.id]));

    device.vault.type("Mine/a.md", "a, edited\n");
    await device.engine.push("Mine/a.md");
    await device.vault.rename("Mine/b.md", "Mine/b2.md");
    await device.engine.renamed("Mine/b.md", "Mine/b2.md");
    await device.vault.remove("Mine/c.md");
    await device.engine.deleted("Mine/c.md");

    const saves = await Promise.all(device.log.to("POST save").slice(-2).map((s) => sentNote(world, s)));
    expect(saves[1], "a rename is a save of the same note, with the new path inside it").toMatchObject({ id: ids["Mine/b.md"], base: 1, path: "Mine/b2.md", text: "b\n" });
    expect(device.log.to("POST delete").map((c) => c.body)).toEqual([{ id: ids["Mine/c.md"], base: 1 }]);
    expect(await nexusTexts(world)).toEqual({ "Mine/a.md": "a, edited\n", "Mine/b2.md": "b\n" });
    const { notes } = device.data();
    expect(notes["Mine/b2.md"], "the renamed note stands on the rename's version, with the same id").toMatchObject({ id: ids["Mine/b.md"], version: 2 });
    expect(notes["Mine/b.md"]).toBeUndefined();
    expect(notes["Mine/c.md"]).toBeUndefined();

    // The feed gives the plugin's own versions back, the old paths included. None of them may bring a note back.
    const before = mark(device);
    await device.engine.sync();
    expect(device.vault.texts(), "the plugin's own save, rename and delete leave the vault as it is when they come back").toEqual({
      "Mine/a.md": "a, edited\n",
      "Mine/b2.md": "b\n",
    });
    expect(requestsSince(device, before).filter((r) => r.method === "POST"), "and nothing is sent in answer").toEqual([]);
  });
});
