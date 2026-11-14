// A note is removed from the vault only when Nexus says it is gone: a 404 for that exact note, or a delete version for it
// in the changes feed. Any other answer to a read of the note (a refusal, a fault in Nexus, a lost sign-in, no network)
// leaves the note as it is, is named in the status line in plain words, and is tried again on the next sync.
// Nexus is the in-memory stand-in (see world.ts); only the answer to one read of one note is replaced, to make it refuse.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyOf, emptyNexus, forbidFetch, loadSync, openWorld, syncedDevice, type Device, type Http, type SyncEngine, type World,
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
  vi.unstubAllGlobals();
});

const PATH = "Ideas/a.md";

/** How a read of one note is answered while a refusal is set: a status, or no network at all. */
type Refusal = { status: number } | "offline";

/** Nexus as the plugin reaches it, except that `GET note` is answered as `refusal.now` says while it is set. Every other call goes through to the stand-in. */
function readsRefused(real: Http, refusal: { now: Refusal | null }): Http {
  return async (request) => {
    const readsANote = (request.method ?? "GET").toUpperCase() === "GET" && new URL(request.url).pathname.endsWith("/note");
    if (!readsANote || refusal.now === null) return real(request);
    if (refusal.now === "offline") throw new Error("net::ERR_INTERNET_DISCONNECTED");
    const text = JSON.stringify({ error: "refused for the test" });
    return {
      status: refusal.now.status,
      text,
      get json() {
        return JSON.parse(text);
      },
    };
  };
}

/** Makes the vault refuse to write one path until `unlock()` is called. */
function lock(device: Device, locked: string): () => void {
  const write = device.vault.write.bind(device.vault);
  let refusing = true;
  device.vault.write = async (path: string, text: string) => {
    if (refusing && path === locked) throw new Error("the file is locked");
    return write(path, text);
  };
  return () => {
    refusing = false;
  };
}

/** An engine over the device's own vault and data whose reads of a note go through `refusal`. */
async function engineWith(device: Device, refusal: { now: Refusal | null }): Promise<SyncEngine> {
  const { createSyncEngine } = await loadSync();
  return createSyncEngine({ ...device.deps, http: readsRefused(device.deps.http, refusal) });
}

/**
 * The state the retry starts from: the vault holds `Ideas/a.md` as Nexus had it (version 1, "one"), Nexus has a newer
 * text ("two") that the vault could not write, so the note waits to be brought down. The lock is lifted before the retry.
 */
async function noteWaitingToComeDown(): Promise<Device> {
  const device = await syncedDevice(world, { [PATH]: "one\n" });
  bodyOf(await world.agents.save(PATH, "two\n", { base: 1 }));
  const unlock = lock(device, PATH);
  await device.engine.sync();
  unlock();
  expect(device.vault.textOf(PATH), "before the retry the vault still has the older text").toBe("one\n");
  expect(device.deps.data.pendingPulls, "and the note waits to be brought down").toEqual([PATH]);
  return device;
}

const removals = (device: Device) => device.log.timeline.filter((step) => step.kind === "remove");

describe("a read of a note that Nexus does not answer with the note", () => {
  const cases: Array<{ name: string; refusal: Refusal; says: RegExp }> = [
    { name: "a 500", refusal: { status: 500 }, says: /nexus had a problem/i },
    { name: "a 429", refusal: { status: 429 }, says: /nexus had a problem/i },
    { name: "a 401", refusal: { status: 401 }, says: /signed out/i },
    { name: "a 403", refusal: { status: 403 }, says: /not allowed.*Ideas\/a\.md/i },
    { name: "a 400", refusal: { status: 400 }, says: /nexus would not give a\.md/i },
    { name: "no network", refusal: "offline", says: /offline/i },
  ];

  it.each(cases)("$name on the retry leaves the note and its text alone, says so, and is tried again on the next sync", async ({ refusal: answer, says }) => {
    const device = await noteWaitingToComeDown();
    const refusal: { now: Refusal | null } = { now: answer };
    const engine = await engineWith(device, refusal);

    await engine.sync();

    expect(device.vault.textOf(PATH), "the note is still in the vault with its text unchanged").toBe("one\n");
    expect(removals(device), "nothing was removed").toEqual([]);
    expect(engine.status(), "the status line names what happened").toMatch(says);
    expect(device.deps.data.pendingPulls, "the note is kept on the list to be tried again").toEqual([PATH]);
    expect(device.deps.data.versions[PATH], "and is still tracked, so it is not mistaken for a new note").toBe(1);

    // Nexus answers again (and the person signs in again, after a 401): the next sync brings the note down.
    refusal.now = null;
    if (device.deps.data.token === null) device.deps.data.token = world.token;
    await engine.sync();

    expect(device.vault.textOf(PATH), "the next sync brought the newer text down").toBe("two\n");
    expect(removals(device)).toEqual([]);
    expect(device.deps.data.pendingPulls ?? []).toEqual([]);
    expect(engine.status()).toMatch(/last synced/i);
  });

  it("a 403 on a note that came down in the feed is named and tried again, not skipped for good", async () => {
    const device = await syncedDevice(world);
    bodyOf(await world.agents.save("Ideas/x.md", "x\n"));
    await device.engine.sync();
    expect(device.vault.textOf("Ideas/x.md")).toBe("x\n");
    // The note is gone from the vault (it was deleted while Obsidian was closed), then another writer moves it in Nexus.
    await device.vault.remove("Ideas/x.md");
    bodyOf(await world.agents.move("Ideas/x.md", "Ideas/y.md"));
    const refusal: { now: Refusal | null } = { now: { status: 403 } };
    const engine = await engineWith(device, refusal);

    await engine.sync();

    expect(device.vault.has("Ideas/y.md")).toBe(false);
    expect(engine.status(), "the status line names the note Nexus would not hand over").toMatch(/not allowed.*Ideas\/y\.md/i);
    expect(device.deps.data.pendingPulls).toEqual(["Ideas/y.md"]);

    refusal.now = null;
    await engine.sync();
    expect(device.vault.textOf("Ideas/y.md"), "once Nexus hands it over, it comes down").toBe("x\n");
    expect(engine.status()).toMatch(/last synced/i);
  });
});

describe("a note Nexus says is gone", () => {
  it("is removed on the retry when Nexus answers 404 for that note", async () => {
    const device = await noteWaitingToComeDown();
    bodyOf(await world.agents.remove(PATH));

    await device.engine.sync();

    expect(device.log.to("GET note").at(-1)?.status, "Nexus said there is no such note").toBe(404);
    expect(device.vault.has(PATH)).toBe(false);
    expect(removals(device)).toEqual([{ kind: "remove", path: PATH }]);
    expect(device.deps.data.pendingPulls ?? []).toEqual([]);
    expect(device.engine.status()).toMatch(/last synced/i);
  });

  it("is removed when the changes feed carries a delete version for it", async () => {
    const device = await syncedDevice(world, { [PATH]: "one\n" });
    bodyOf(await world.agents.remove(PATH));

    await device.engine.sync();

    expect(device.vault.has(PATH)).toBe(false);
    expect(removals(device)).toEqual([{ kind: "remove", path: PATH }]);
    expect(device.deps.data.versions[PATH]).toBeUndefined();
  });
});
