// With no key unlocked, the plugin syncs nothing and says so. The key comes from the unlock port (src/unlock.ts), which the setup
// screens will fill in a later piece of work; until they do, the plugin as it is shipped is given a port that never holds one. A
// vault that is locked sends nothing and reads nothing from Nexus, keeps what is edited meanwhile, and carries on when the key is
// there. If the key goes away in the middle of a sync, the sync stops where it is and the cursor does not move past what was not read.
// Against the real server (see real-nexus.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NEVER_UNLOCKED } from "../src/unlock";
import { emptyNexus, forbidFetch, known, loadSync, makeDevice, nexusTexts, openWorld, syncedDevice, type Device, type Http, type World } from "./world";

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

const JARGON = /\b(401|403|409|500|http|status code|kid|blob|decrypt\w*|libsodium)\b/i;

describe("a vault that is locked", () => {
  it("sends nothing and reads nothing, however the engine is asked, and says that it is locked in plain words", async () => {
    await world.elsewhere.create("Ideas/there.md", "already in Nexus\n");
    const device = await makeDevice(world, { files: { "Ideas/a.md": "a note\n", "Ideas/b.md": "b note\n" }, unlock: null });

    await device.engine.sync();
    await device.engine.push("Ideas/a.md");
    await device.engine.renamed("Ideas/b.md", "Ideas/c.md");
    await device.engine.deleted("Ideas/c.md");
    await device.engine.cameToFront();

    expect(device.log.requests(), "not one call to Nexus").toEqual([]);
    expect(device.engine.status()).toMatch(/locked/i);
    expect(device.engine.status(), "in plain words").not.toMatch(JARGON);
    expect(device.vault.texts(), "the vault is as it was: nothing came down, nothing was taken away").toEqual({ "Ideas/a.md": "a note\n", "Ideas/b.md": "b note\n" });
    expect(device.notices).toEqual([]);
    expect(device.data().cursor, "and it has not been marked as synced").toBeNull();
    expect(await nexusTexts(world), "Nexus holds only what was already there").toEqual({ "Ideas/there.md": "already in Nexus\n" });
  });

  it("is what the plugin is shipped with: its entry hands the engine a port that never holds a key", () => {
    expect(NEVER_UNLOCKED.keys()).toBeNull();
    const entry = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(entry, "main.ts gives the engine the port that never holds a key, until the setup screens are there").toMatch(/unlock:\s*NEVER_UNLOCKED/);
    expect(entry, "and has no other way to make a key").not.toMatch(/generateVaultKey|vaultKey/);
  });

  it("is still not set up, or signed out, before it is locked: the status names the first thing to do", async () => {
    const notSetUp = await makeDevice(world, { address: "", user: "", unlock: null });
    await notSetUp.engine.sync();
    expect(notSetUp.engine.status()).toMatch(/not set up/i);

    const signedOut = await makeDevice(world, { token: null, unlock: null });
    await signedOut.engine.sync();
    expect(signedOut.engine.status()).toMatch(/signed out/i);
  });

  it("keeps what is edited meanwhile, and everything goes the first time the key is there: the edit up, Nexus's notes down", async () => {
    const before = await syncedDevice(world, { "Ideas/a.md": "a\n", "Ideas/b.md": "b\n" });
    const locked = await makeDevice(world, { vault: before.vault, from: before.data(), unlock: null });
    locked.vault.type("Ideas/a.md", "a, edited while locked\n");
    locked.vault.type("Ideas/new.md", "made while locked\n");
    await world.elsewhere.create("Ideas/elsewhere.md", "made elsewhere\n");

    await locked.engine.sync();
    locked.engine.edited("Ideas/a.md");
    await locked.engine.push("Ideas/a.md");
    expect(locked.log.requests()).toEqual([]);
    expect(locked.engine.status()).toMatch(/locked/i);

    locked.unlock.unlock(world.keys);
    expect(locked.engine.status(), "the status does not say locked once it is unlocked").not.toMatch(/locked/i);
    await locked.engine.sync();

    expect(await nexusTexts(world)).toEqual({
      "Ideas/a.md": "a, edited while locked\n",
      "Ideas/b.md": "b\n",
      "Ideas/new.md": "made while locked\n",
      "Ideas/elsewhere.md": "made elsewhere\n",
    });
    expect(locked.vault.textOf("Ideas/elsewhere.md")).toBe("made elsewhere\n");
    expect(locked.engine.status()).toMatch(/last synced/i);
  });

  it("holds a delete made while locked, and tells Nexus once the key is there", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.unlock.lock();
    await device.vault.remove("Ideas/a.md");
    await device.engine.deleted("Ideas/a.md");
    expect(device.log.to("POST delete"), "nothing is sent while locked").toEqual([]);
    expect(device.data().pendingDeletes).toHaveLength(1);

    device.unlock.unlock(world.keys);
    await device.engine.sync();

    expect(await nexusTexts(world)).toEqual({});
    expect(device.data().pendingDeletes).toEqual([]);
  });

  it("locked again after a sync, sends nothing more", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    device.unlock.lock();
    device.vault.type("Ideas/a.md", "a, edited\n");
    const sent = device.log.requests().length;

    await device.engine.sync();
    await device.engine.push("Ideas/a.md");

    expect(device.log.requests().length).toBe(sent);
    expect(device.engine.status()).toMatch(/locked/i);
  });
});

describe("the key going away in the middle of a sync", () => {
  /** An engine over the device's own vault and data, whose first read of the changes feed is followed by the vault being locked. */
  async function lockedAfterTheFeed(device: Device) {
    const { createSyncEngine } = await loadSync();
    const real: Http = device.deps.http;
    let done = false;
    const http: Http = async (request) => {
      const answer = await real(request);
      if (!done && new URL(request.url).pathname.endsWith("/changes")) {
        done = true;
        device.unlock.lock();
      }
      return answer;
    };
    return createSyncEngine({ ...device.deps, http });
  }

  it("stops the sync where it is: nothing is written from what was read, nothing is sent, and the cursor stays", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    const cursor = device.data().cursor;
    await world.elsewhere.create("Ideas/arrives.md", "from elsewhere\n");
    device.vault.type("Ideas/a.md", "a, edited\n");
    const engine = await lockedAfterTheFeed(device);

    await expect(engine.cameToFront()).resolves.toBeUndefined();

    expect(device.vault.textOf("Ideas/arrives.md"), "the note that was read is not written without the key to open it").toBeUndefined();
    expect(device.log.to("POST save")).toEqual([]);
    expect(device.deps.data.cursor, "the cursor did not move past a note that was never opened").toBe(cursor);
    expect(engine.status()).toMatch(/locked/i);

    device.unlock.unlock(world.keys);
    await engine.sync();
    expect(device.vault.textOf("Ideas/arrives.md"), "the next sync with the key brings it").toBe("from elsewhere\n");
    expect(await nexusTexts(world)).toMatchObject({ "Ideas/a.md": "a, edited\n" });
  });

  it("is known to the test: a locked device holding a note's id does not forget it", async () => {
    const device = await makeDevice(world, { files: { "Ideas/a.md": "edited\n" }, notes: { "Ideas/a.md": known("Ideas/a.md", "before\n", 1, "keptidkeptidkeptidkept") }, cursor: "0", unlock: null });
    await device.engine.push("Ideas/a.md");
    expect(device.deps.data.notes["Ideas/a.md"]).toMatchObject({ id: "keptidkeptidkeptidkept", version: 1 });
  });
});
