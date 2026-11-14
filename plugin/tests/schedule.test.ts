// When the plugin acts: a local edit goes up after a 3 second pause in typing (each new edit of a note starts the
// pause again), and the changes come down when Obsidian starts, every 30 seconds while it is open, and when the
// app comes back to the front. Timers are faked and the clock is not: Nexus reads the clock for its
// saves. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_PAUSE, SYNC_EVERY, emptyNexus, fakeTimers, forbidFetch, loadSync, nexusTexts, openWorld, quiet, sentNote, syncedDevice, type World,
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

describe("the pause before an edit goes up", () => {
  it("is 3 seconds, and the sync interval is 30", async () => {
    const { EDIT_PAUSE_MS, SYNC_EVERY_MS } = await loadSync();
    expect(EDIT_PAUSE_MS).toBe(EDIT_PAUSE);
    expect(SYNC_EVERY_MS).toBe(SYNC_EVERY);
  });

  it("sends the note's latest text once, 3 seconds after the last edit", async () => {
    const device = await syncedDevice(world, { "Ideas/t.md": "v1\n" });
    fakeTimers();

    device.vault.type("Ideas/t.md", "first\n");
    device.engine.edited("Ideas/t.md");
    await vi.advanceTimersByTimeAsync(2000);
    device.vault.type("Ideas/t.md", "second\n");
    device.engine.edited("Ideas/t.md");

    await vi.advanceTimersByTimeAsync(EDIT_PAUSE - 1);
    expect(device.log.to("POST save"), "typing again starts the pause again").toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const saves = device.log.to("POST save");
    expect(saves, "then one save").toHaveLength(1);
    expect(await sentNote(world, saves[0]), "with the text as it is now and the stored version").toMatchObject({ path: "Ideas/t.md", text: "second\n", base: 1 });
    await quiet(device.log);
    expect(await nexusTexts(world)).toEqual({ "Ideas/t.md": "second\n" });
  });

  it("keeps a separate pause for each note", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    fakeTimers();

    device.vault.type("Ideas/a.md", "a2\n");
    device.engine.edited("Ideas/a.md");
    await vi.advanceTimersByTimeAsync(1000);
    device.vault.type("Ideas/b.md", "b2\n");
    device.engine.edited("Ideas/b.md");

    await vi.advanceTimersByTimeAsync(EDIT_PAUSE - 1000);
    const sentPaths = async () => (await Promise.all(device.log.to("POST save").map((s) => sentNote(world, s)))).map((n) => n.path);
    expect(await sentPaths(), "a's pause is over, b's is not").toEqual(["Ideas/a.md"]);
    await quiet(device.log);
    await vi.advanceTimersByTimeAsync(1000);
    await quiet(device.log);
    expect(await sentPaths()).toEqual(["Ideas/a.md", "Ideas/b.md"]);
    await quiet(device.log);
  });
});

describe("when the changes come down", () => {
  it("at start, every 30 seconds while it runs, and when the app comes to the front, and no more once it is stopped", async () => {
    const device = await syncedDevice(world);
    fakeTimers();
    // How many times the feed has been asked. One pass may ask more than once (a last, empty page tells it to stop),
    // so the test looks for passes happening or not, never for an exact count of calls.
    const asked = () => device.log.to("GET changes").length;

    device.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    await quiet(device.log);
    const atStart = asked();
    expect(atStart, "it asks at start").toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(SYNC_EVERY - 1);
    await quiet(device.log);
    expect(asked(), "not again before 30 seconds").toBe(atStart);
    await vi.advanceTimersByTimeAsync(1);
    await quiet(device.log);
    const atThirty = asked();
    expect(atThirty, "again at 30 seconds").toBeGreaterThan(atStart);

    await world.elsewhere.create("Ideas/from-elsewhere.md", "hello\n");
    await vi.advanceTimersByTimeAsync(SYNC_EVERY);
    await quiet(device.log);
    const atSixty = asked();
    expect(atSixty, "and again 30 seconds after that").toBeGreaterThan(atThirty);
    expect(device.vault.textOf("Ideas/from-elsewhere.md"), "what was made elsewhere has come down").toBe("hello\n");

    await device.engine.cameToFront();
    expect(asked(), "and when the app comes back to the front").toBeGreaterThan(atSixty);

    device.engine.stop();
    await quiet(device.log);
    const stopped = asked();
    await vi.advanceTimersByTimeAsync(SYNC_EVERY * 3);
    await quiet(device.log);
    expect(asked(), "nothing after stop").toBe(stopped);
  });
});
