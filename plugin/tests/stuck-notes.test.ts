// A note that cannot go up, or cannot come down, must neither strand the notes beside it nor be forgotten by the status
// line. A failed send leaves every other waiting note waiting; a note Nexus refuses stays named in the status line until
// it is dealt with, even after other notes go up; one remote note the vault cannot write is reported and set aside for
// that sync, and the pulls after it carry on (it is tried again on later syncs: unwritable-retry.test.ts). Against the
// in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyNexus, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

describe("a send that fails part way through the waiting notes", () => {
  it("leaves the rest waiting, says offline and not 'last synced', and sends them all on the next sync", async () => {
    const before = await syncedDevice(world, { "Ideas/a.md": "a\n", "Ideas/b.md": "b\n", "Ideas/c.md": "c\n" });
    // Edited while Obsidian was closed: all three wait for the start-up look at the vault.
    for (const name of ["a", "b", "c"]) before.vault.type(`Ideas/${name}.md`, `${name}, edited\n`);
    const device = await makeDevice(world, { vault: before.vault, from: before.data(), unlock: before.unlock });

    // Nexus goes away just after the last note is read by that look, so the first send fails with two still waiting.
    const read = device.vault.read.bind(device.vault);
    let cut = false;
    device.vault.read = async (path: string) => {
      const text = await read(path);
      if (path === "Ideas/c.md" && !cut) {
        cut = true;
        device.network.online = false;
      }
      return text;
    };
    await device.engine.sync();
    expect(device.engine.status()).toMatch(/offline/i);
    expect(device.engine.status()).not.toMatch(/last synced/i);
    expect(device.log.to("POST save"), "nothing went up while Nexus was away").toEqual([]);

    device.network.online = true;
    await device.engine.sync();

    expect(await nexusTexts(world), "all three go up, not only the one that failed").toEqual({
      "Ideas/a.md": "a, edited\n",
      "Ideas/b.md": "b, edited\n",
      "Ideas/c.md": "c, edited\n",
    });
    expect(device.engine.status()).toMatch(/last synced/i);
  });
});

/** More than the server keeps in one note (it keeps up to 1,000,000 bytes of blob): the server refuses it, in words. */
const TOO_BIG = "x".repeat(1_100_000);

describe("a note Nexus refuses", () => {
  it("stays in the status line when other notes go up, and leaves it when the note is gone", async () => {
    const device = await makeDevice(world, { files: { "Big/diary.md": TOO_BIG, "Ideas/ok.md": "fine\n" }, cursor: "0" });

    await device.engine.push("Big/diary.md");
    expect(device.log.to("POST save")[0].status, "Nexus refused the note for its size").toBe(413);
    expect(device.engine.status(), "in plain words, naming the note").toMatch(/would not take diary\.md/i);
    expect(device.engine.status()).not.toMatch(/\b(413|http|status code)\b/i);

    await device.engine.push("Ideas/ok.md");
    expect(device.data().notes["Ideas/ok.md"].version, "the rest of the vault still syncs").toBe(1);
    expect(device.engine.status(), "but the refused note is still named, not covered by a later success").toMatch(/would not take diary\.md/i);
    expect(device.engine.status()).not.toMatch(/last synced/i);

    await device.vault.remove("Big/diary.md");
    await device.engine.deleted("Big/diary.md");
    expect(device.engine.status(), "once the note is gone there is nothing left to refuse").toMatch(/last synced/i);
  });
});

describe("a remote note the vault cannot write", () => {
  it("is reported once and set aside, and the notes after it and the pulls after that carry on", async () => {
    const device = await syncedDevice(world);
    const write = device.vault.write.bind(device.vault);
    device.vault.write = async (path: string, text: string) => {
      if (path === "Locked/x.md") throw new Error("the file is locked");
      return write(path, text);
    };
    await world.elsewhere.create("Locked/x.md", "cannot land\n");
    await world.elsewhere.create("Fine/y.md", "lands\n");

    await expect(device.engine.sync()).resolves.toBeUndefined();

    expect(device.vault.textOf("Fine/y.md"), "the note after it came down").toBe("lands\n");
    expect(device.vault.has("Locked/x.md")).toBe(false);
    expect(device.notices, "one notice").toHaveLength(1);
    expect(device.notices[0]).toContain("x.md");
    expect(device.engine.status(), "the status line names it").toContain("x.md");
    expect(device.engine.status()).not.toMatch(/last synced/i);

    await world.elsewhere.create("Fine/z.md", "later\n");
    await device.engine.sync();
    expect(device.vault.textOf("Fine/z.md"), "and the next pull is not stopped by it").toBe("later\n");
    expect(device.notices, "not announced again").toHaveLength(1);
  });
});
