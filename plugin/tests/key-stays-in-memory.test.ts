// The vault key is held in memory while unlocked and is never written to disk by this plugin. A device is run through everything it
// does (a first sync, an edit, a rename, a delete, a note that comes down, a note it cannot open, a clash, a restart), and then
// what it kept (the data it persisted), what it wrote into the vault, what it sent, what it showed (the status line and the notices)
// and what it logged are searched for the key's bytes, written every way they could be: as hex, base64, url-safe base64, or the list
// of numbers. Against the real server (see real-nexus.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { foundIn } from "./leaks";
import { bodyOf, emptyNexus, forbidFetch, makeDevice, openWorld, syncedDevice, tampered, type World } from "./world";

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
  vi.restoreAllMocks();
});

/** The key's bytes in each way they could be written down. */
function shapesOf(key: Uint8Array): string[] {
  const bytes = Buffer.from(key);
  return [
    bytes.toString("hex"),
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    JSON.stringify(Array.from(key)),
    Array.from(key).join(","),
    JSON.stringify(key),
  ];
}

describe("the vault key", () => {
  it("is not in anything the plugin keeps, writes, sends, shows or logs, through everything it does", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(" ")));
    }
    const needles = shapesOf(world.keys.vaultKey);

    // The searcher can find the key where it is, in every shape.
    for (const shape of needles) expect(foundIn(`x ${shape} x`, [shape]), `looks for ${shape.slice(0, 12)}…`).toEqual([shape]);
    expect(needles.length).toBeGreaterThanOrEqual(6);

    // A device through everything.
    const other = await world.elsewhere.create("Ideas/arrives.md", "from elsewhere\n");
    const device = await syncedDevice(world, { "Ideas/a.md": "one\ntwo\n", "Ideas/b.md": "b\n", "Ideas/c.md": "c\n" });
    await device.engine.sync();
    device.vault.type("Ideas/a.md", "one\nTWO here\n");
    await world.elsewhere.update(device.data().notes["Ideas/a.md"].id, "Ideas/a.md", "one\nTWO there\n");
    await device.engine.push("Ideas/a.md"); // a clash
    await device.vault.rename("Ideas/b.md", "Ideas/b2.md");
    await device.engine.renamed("Ideas/b.md", "Ideas/b2.md");
    await device.vault.remove("Ideas/c.md");
    await device.engine.deleted("Ideas/c.md");
    const head = bodyOf(await world.agents.note(other.id)).version as number;
    bodyOf(await world.agents.save(other.id, tampered(bodyOf(await world.owner.note(other.id)).blob), { base: head, kid: world.keys.kid }));
    await device.engine.sync(); // a note that does not open
    device.unlock.lock();
    await device.engine.sync();
    device.unlock.unlock(world.keys);
    const restarted = await makeDevice(world, { vault: device.vault, from: device.data(), unlock: device.unlock });
    await restarted.engine.sync();
    expect(restarted.engine.status(), "the run went through the note that did not open").toContain(other.id);

    for (const [what, text] of [
      ["the data the plugin persisted", JSON.stringify([...device.saved, ...restarted.saved])],
      ["the data it holds", JSON.stringify([device.deps.data, restarted.deps.data])],
      ["what it wrote into the vault", JSON.stringify([...device.log.timeline, ...restarted.log.timeline].filter((s) => s.kind !== "request"))],
      ["what it sent and was answered", JSON.stringify([...device.log.requests(), ...restarted.log.requests()])],
      ["the files in the vault", JSON.stringify(device.vault.texts())],
      ["its notices and its status line", JSON.stringify([...device.notices, ...restarted.notices, device.engine.status(), restarted.engine.status()])],
      ["what it logged", logged.join("\n")],
    ] as const) {
      expect(foundIn(text, needles), `${what} holds no part of the key`).toEqual([]);
    }
  });

  it("is not a field of the data the plugin keeps, and the engine asks for it each time rather than keeping a copy", async () => {
    const device = await syncedDevice(world, { "Ideas/a.md": "a\n" });
    expect(Object.keys(device.data()).sort()).not.toContain("vaultKey");
    expect(JSON.stringify(device.data())).not.toMatch(/vaultKey|vaultId/);

    // Take the key away: an engine that had kept a copy would go on sending.
    device.unlock.lock();
    device.vault.type("Ideas/a.md", "a, edited\n");
    await device.engine.push("Ideas/a.md");
    expect(device.log.to("POST save"), "nothing went up with a key that was taken away").toEqual([]);
  });

  it("is made, and unwrapped from a Recovery Key or a password, by no source file of the plugin: those belong to the setup screens, which are later work; only the approval engine opens an approval", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const written = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(dir + f, "utf8")] as const);
    expect(written.length, "the sources were found").toBeGreaterThan(8);
    for (const [file, source] of written) {
      expect(source, `${file} neither makes nor unwraps a vault key`).not.toMatch(/generateVaultKey|generateRecoveryKey|parseRecoveryKey|unwrapVaultKeyWithRecoveryKey|openPasswordWrap/);
      if (file !== "approval.ts") expect(source, `${file} does not open an approval: only approval.ts does, and it holds the key back until the person has checked the code`).not.toMatch(/openApproval/);
    }
  });
});
