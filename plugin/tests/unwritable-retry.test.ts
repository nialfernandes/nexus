// A remote note the vault cannot write is reported, and tried again on every sync until it can be written, with the
// status line naming it meanwhile. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyNexus, forbidFetch, makeDevice, openWorld, syncedDevice, type Device, type World } from "./world";

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

describe("a remote note the vault could not write", () => {
  it("comes down on a later sync once the vault can write it, with nothing new in Nexus, and leaves the status line", async () => {
    const device = await syncedDevice(world);
    const unlock = lock(device, "Locked/x.md");
    const locked = await world.elsewhere.create("Locked/x.md", "waits\n");

    await device.engine.sync();
    expect(device.vault.has("Locked/x.md")).toBe(false);
    expect(device.engine.status()).toContain("x.md");
    expect(device.notices).toHaveLength(1);

    await device.engine.sync(); // still locked: tried again, still named, not announced again
    expect(device.vault.has("Locked/x.md")).toBe(false);
    expect(device.engine.status()).toContain("x.md");
    expect(device.notices, "one notice however many tries").toHaveLength(1);

    unlock();
    await device.engine.sync();
    expect(device.vault.textOf("Locked/x.md"), "it came down on the next sync").toBe("waits\n");
    expect(device.engine.status(), "and the status line is clear").toMatch(/last synced/i);
    expect(device.data().notes["Locked/x.md"]).toMatchObject({ id: locked.id, version: 1 });
    expect(device.data().pendingPulls ?? []).toEqual([]);
  });

  it("is still tried again after Obsidian is restarted, with nothing new in Nexus", async () => {
    const device = await syncedDevice(world);
    const unlock = lock(device, "Locked/x.md");
    await world.elsewhere.create("Locked/x.md", "first\n");
    await device.engine.sync();
    expect(device.vault.has("Locked/x.md")).toBe(false);
    unlock(); // the file can be written by the time Obsidian is opened again

    const restarted = await makeDevice(world, { vault: device.vault, from: device.data(), unlock: device.unlock });
    await restarted.engine.sync();

    expect(restarted.vault.textOf("Locked/x.md"), "it was kept in the plugin's own state, so a restart does not forget it").toBe("first\n");
  });

  it("is dropped quietly when Nexus no longer has the note", async () => {
    const device = await syncedDevice(world);
    lock(device, "Locked/x.md");
    const locked = await world.elsewhere.create("Locked/x.md", "waits\n");
    await device.engine.sync();
    await world.elsewhere.remove(locked.id);

    await device.engine.sync();

    expect(device.vault.has("Locked/x.md")).toBe(false);
    expect(device.engine.status()).toMatch(/last synced/i);
    expect(device.data().pendingPulls ?? []).toEqual([]);
  });
});
