// What other writers do in Nexus comes down to the vault from the changes feed, each change once, however many
// times and in however many pages the plugin asks. A save writes the note, a move renames it and a delete removes
// it. What the plugin's own writes and renames and removals cause in Obsidian is never sent back, and what the plugin
// itself sent comes back in the feed as a no-op. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_PAUSE, bodyOf, emptyNexus, fakeTimers, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, type Device, type World,
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

    bodyOf(await world.agents.save("Agents/new.md", "first\n"));
    bodyOf(await world.agents.save("Agents/new.md", "second\n", { base: 1 }));
    bodyOf(await world.agents.move("Agents/new.md", "Agents/renamed.md"));
    bodyOf(await world.agents.save("Agents/temp.md", "temp\n"));
    bodyOf(await world.agents.remove("Agents/temp.md"));
    bodyOf(await world.agents.save("Agents/other.md", "other\n"));
    bodyOf(await world.agents.save("Agents/other.md", "other, edited\n", { base: 1 }));
    await device.engine.sync();

    expect(device.vault.texts()).toEqual({ "Agents/renamed.md": "second\n", "Agents/other.md": "other, edited\n" });
    const versions = device.data().versions;
    expect(versions["Agents/renamed.md"], "the move was the note's third version").toBe(3);
    expect(versions["Agents/other.md"]).toBe(2);
    expect(versions["Agents/new.md"], "a note that moved is no longer stored at its old path").toBeUndefined();
    expect(versions["Agents/temp.md"], "nor is a note that was deleted").toBeUndefined();
    expect(device.log.to("POST save"), "bringing changes down sends nothing up").toEqual([]);
  });

  it("are taken once: asking again, in this run or after a restart, applies nothing twice", async () => {
    const device = await syncedDevice(world);
    bodyOf(await world.agents.save("Once/a.md", "a\n"));
    bodyOf(await world.agents.move("Once/a.md", "Once/b.md"));
    bodyOf(await world.agents.save("Once/c.md", "c\n"));
    bodyOf(await world.agents.remove("Once/c.md"));
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

    const restarted = await makeDevice(world, { vault: device.vault, from: device.data() });
    await restarted.engine.sync();
    expect(vaultChangesSince(restarted, 0), "a restart carries on from the stored cursor").toEqual([]);
    expect(restarted.log.to("GET changes")[0].query.after).toBe(cursor);

    bodyOf(await world.agents.save("Once/d.md", "d\n"));
    await restarted.engine.sync();
    expect(vaultChangesSince(restarted, 0), "and picks up only what is new").toEqual([{ kind: "write", path: "Once/d.md", text: "d\n" }]);
  });

  it("come down whole when there are more of them than one page of the feed holds", async () => {
    const device = await syncedDevice(world);
    const paths: string[] = [];
    for (let batch = 0; batch < 11; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const path = `Bulk/n${String(batch * 10 + i).padStart(3, "0")}.md`;
          paths.push(path);
          bodyOf(await world.agents.save(path, `note ${path}\n`));
        }),
      );
    }
    expect(paths).toHaveLength(110);
    await device.engine.sync();

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
    bodyOf(await world.agents.save("Echo/keep.md", "keep, edited elsewhere\n", { base: 1 }));
    bodyOf(await world.agents.move("Echo/old.md", "Echo/new.md"));
    bodyOf(await world.agents.remove("Echo/gone.md"));
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

  it("leave a clash version out: the feed carries the text that was kept beside the note, and it is not the note's text", async () => {
    const device = await syncedDevice(world);
    bodyOf(await world.agents.save("Clash/n.md", "zero\n"));
    bodyOf(await world.agents.save("Clash/n.md", "one\ntwo\n", { base: 1 }));
    bodyOf(await world.agents.save("Clash/n.md", "one\nREMOTE\n", { base: 2 }));
    // Another device saves a text that cannot be merged: Nexus keeps it as version 4, a clash version.
    expect((await world.owner.save("Clash/n.md", "one\nLOCAL\n", { base: 2 })).status).toBe(409);
    await device.engine.sync();

    expect(device.vault.textOf("Clash/n.md"), "the note holds the latest text that is the note's, not the clash version").toBe("one\nREMOTE\n");
    expect(device.data().versions["Clash/n.md"], "and stands on version 3").toBe(3);

    bodyOf(await world.agents.save("Clash/n.md", "one\nREMOTE, later\n", { base: 3 }));
    await device.engine.sync();
    expect(device.vault.textOf("Clash/n.md")).toBe("one\nREMOTE, later\n");
    expect(device.data().versions["Clash/n.md"], "version 5: the clash took version 4").toBe(5);
  });

  it("never overwrite an edit that has not gone up yet", async () => {
    bodyOf(await world.agents.save("Race/n.md", "one\ntwo\n"));
    const device = await syncedDevice(world, { "Race/n.md": "one\ntwo\n" });

    // The person types a second line change; before it goes up, another device changes the first line.
    device.vault.type("Race/n.md", "one\nTWO\n");
    fakeTimers();
    device.engine.edited("Race/n.md");
    bodyOf(await world.agents.save("Race/n.md", "ONE\ntwo\n", { base: 1 }));
    await device.engine.sync();
    await device.engine.push("Race/n.md");

    const texts = Object.values(device.vault.texts());
    expect(texts.some((t) => t.includes("TWO")), "the person's edit is still in the vault, in the note or in a copy").toBe(true);
    expect(device.vault.textOf("Race/n.md"), "and the other device's edit is in the note").toContain("ONE");
  });
});

describe("changes made in the vault", () => {
  it("become a move and a delete in Nexus, and what comes back in the feed is a no-op", async () => {
    const device = await syncedDevice(world, { "Mine/a.md": "a\n", "Mine/b.md": "b\n", "Mine/c.md": "c\n" });

    device.vault.type("Mine/a.md", "a, edited\n");
    await device.engine.push("Mine/a.md");
    await device.vault.rename("Mine/b.md", "Mine/b2.md");
    await device.engine.renamed("Mine/b.md", "Mine/b2.md");
    await device.vault.remove("Mine/c.md");
    await device.engine.deleted("Mine/c.md");

    expect(device.log.to("POST move").map((c) => c.body)).toEqual([{ from: "Mine/b.md", to: "Mine/b2.md" }]);
    expect(device.log.to("POST delete").map((c) => c.body)).toEqual([{ path: "Mine/c.md" }]);
    expect(await nexusTexts(world)).toEqual({ "Mine/a.md": "a, edited\n", "Mine/b2.md": "b\n" });
    const versions = device.data().versions;
    expect(versions["Mine/b2.md"], "the moved note stands on the move's version").toBe(2);
    expect(versions["Mine/b.md"]).toBeUndefined();
    expect(versions["Mine/c.md"]).toBeUndefined();

    // The feed gives the plugin's own versions back, the old paths included. None of them may bring a note back.
    const before = mark(device);
    await device.engine.sync();
    expect(device.vault.texts(), "the plugin's own save, move and delete leave the vault as it is when they come back").toEqual({
      "Mine/a.md": "a, edited\n",
      "Mine/b2.md": "b\n",
    });
    expect(requestsSince(device, before).filter((r) => r.method === "POST"), "and nothing is sent in answer").toEqual([]);
  });
});
