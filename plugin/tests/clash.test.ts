// A clash never loses anything. When Nexus answers 409 because two edits touch the same line, the plugin keeps the
// vault's text in a sibling note named `<name> (clash <device> <date>).md`, writes Nexus's text into the note, stores
// Nexus's version for it and shows a notice that names both. The person merges by hand and deletes the copy.
// Against the in-memory Nexus (see world.ts for the contract and where each piece comes from).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, emptyNexus, forbidFetch, makeDevice, openWorld, type Device, type World } from "./world";

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

/** The clash copies of a note in the vault: its name, then ` (clash `. */
const copiesOf = (device: Device, folderAndName: string): string[] => device.vault.pathsStarting(`${folderAndName} (clash `);

/** A note with three versions: an edit on another device changed the second line after the plugin saw version 2. */
async function noteMovedOnAfterVersionTwo(path: string): Promise<void> {
  bodyOf(await world.agents.save(path, "zero\n"));
  bodyOf(await world.agents.save(path, "one\ntwo\n", { base: 1 }));
  bodyOf(await world.agents.save(path, "one\nREMOTE\n", { base: 2 }));
}

describe("a 409 on an edit", () => {
  it("keeps the vault's text in a sibling note, writes Nexus's text to the note and says so in a notice", async () => {
    await noteMovedOnAfterVersionTwo("Ideas/a.md");
    const device = await makeDevice(world, {
      files: { "Ideas/a.md": "one\nLOCAL\n", "Ideas/other.md": "untouched\n" },
      versions: { "Ideas/a.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/a.md");

    const saves = device.log.to("POST save");
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toEqual({ path: "Ideas/a.md", text: "one\nLOCAL\n", base: 2 });
    expect(saves[0].status, "the same line was changed on both sides").toBe(409);

    const copies = copiesOf(device, "Ideas/a");
    expect(copies, "one copy, named for the note, the device and the day").toHaveLength(1);
    expect(copies[0]).toMatch(/^Ideas\/a \(clash Test iPhone 2026-11-14[^)]*\)\.md$/);
    expect(device.vault.textOf(copies[0]), "the copy holds the vault's text").toBe("one\nLOCAL\n");
    expect(device.vault.textOf("Ideas/a.md"), "the note holds Nexus's text").toBe("one\nREMOTE\n");
    expect(device.data().versions["Ideas/a.md"], "the note now stands on Nexus's version").toBe(3);
    expect(device.vault.textOf("Ideas/other.md")).toBe("untouched\n");

    expect(device.notices, "one notice").toHaveLength(1);
    expect(device.notices[0], "it names the note").toContain("a.md");
    expect(device.notices[0], "and the copy").toContain(copies[0].split("/").pop()!);
  });

  it("keeps Nexus's own text as the note's latest version, so nothing of either side is lost there either", async () => {
    await noteMovedOnAfterVersionTwo("Ideas/kept.md");
    const device = await makeDevice(world, {
      files: { "Ideas/kept.md": "one\nLOCAL\n" },
      versions: { "Ideas/kept.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/kept.md");

    expect(bodyOf(await world.owner.note("Ideas/kept.md")).text, "Nexus's latest text is still the other device's").toBe("one\nREMOTE\n");
    const history = bodyOf(await world.owner.history("Ideas/kept.md")).versions as Array<{ version: number; clash: boolean }>;
    expect(history.find((v) => v.clash)?.version, "and the vault's text is kept there as a clash version").toBe(4);
  });

  it("is not undone by the next pull: the clash version comes back in the feed and changes neither the note nor the copy", async () => {
    await noteMovedOnAfterVersionTwo("Ideas/pulled.md");
    const device = await makeDevice(world, {
      files: { "Ideas/pulled.md": "one\nLOCAL\n" },
      versions: { "Ideas/pulled.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/pulled.md");
    const copies = copiesOf(device, "Ideas/pulled");
    expect(copies).toHaveLength(1);
    const before = device.vault.texts();

    await device.engine.sync();

    expect(device.vault.texts(), "the vault is as the clash left it").toEqual(before);
    expect(device.data().versions["Ideas/pulled.md"]).toBe(3);
    expect(device.notices, "and the clash is not announced a second time").toHaveLength(1);
  });

  it("treats a note made here at a path Nexus already holds the same way", async () => {
    bodyOf(await world.agents.save("Ideas/b.md", "from nexus\n"));
    const device = await makeDevice(world, { files: { "Ideas/b.md": "made here\n" }, cursor: "0" });
    await device.engine.push("Ideas/b.md");

    expect(device.log.to("POST save")[0].body, "no version is stored, so no base is sent").toEqual({ path: "Ideas/b.md", text: "made here\n" });
    expect(device.log.to("POST save")[0].status).toBe(409);
    const copies = copiesOf(device, "Ideas/b");
    expect(copies).toHaveLength(1);
    expect(device.vault.textOf(copies[0])).toBe("made here\n");
    expect(device.vault.textOf("Ideas/b.md")).toBe("from nexus\n");
    expect(device.data().versions["Ideas/b.md"]).toBe(1);
    expect(device.notices).toHaveLength(1);
  });

  it("names the copy beside a note at the top of the vault without inventing a folder", async () => {
    bodyOf(await world.agents.save("top.md", "from nexus\n"));
    const device = await makeDevice(world, { files: { "top.md": "made here\n" }, cursor: "0" });
    await device.engine.push("top.md");

    const copies = copiesOf(device, "top");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^top \(clash Test iPhone 2026-11-14[^)]*\)\.md$/);
    expect(device.vault.textOf(copies[0])).toBe("made here\n");
  });

  it("never overwrites an earlier copy: a second clash on the same note, the same day, makes a second copy", async () => {
    await noteMovedOnAfterVersionTwo("Ideas/twice.md");
    const device = await makeDevice(world, {
      files: { "Ideas/twice.md": "one\nLOCAL\n" },
      versions: { "Ideas/twice.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/twice.md");
    expect(device.vault.textOf("Ideas/twice.md")).toBe("one\nREMOTE\n");

    // The person keeps typing, and the other device moves the note on again: the same line, a second time.
    bodyOf(await world.agents.save("Ideas/twice.md", "one\nREMOTE AGAIN\n", { base: 3 }));
    device.vault.type("Ideas/twice.md", "one\nLOCAL AGAIN\n");
    await device.engine.push("Ideas/twice.md");

    const copies = copiesOf(device, "Ideas/twice");
    expect(copies, "two copies, not one written over").toHaveLength(2);
    expect(copies.map((p) => device.vault.textOf(p)).sort()).toEqual(["one\nLOCAL\n", "one\nLOCAL AGAIN\n"].sort());
    expect(device.vault.textOf("Ideas/twice.md")).toBe("one\nREMOTE AGAIN\n");
    expect(device.notices).toHaveLength(2);
  });

  it("writes a copy whose name is a legal file name even when the device's name is not one", async () => {
    await noteMovedOnAfterVersionTwo("Ideas/legal.md");
    const device = await makeDevice(world, {
      name: "Mac/Studio: 2",
      files: { "Ideas/legal.md": "one\nLOCAL\n" },
      versions: { "Ideas/legal.md": 2 },
      cursor: "0",
    });
    await device.engine.push("Ideas/legal.md");

    const copies = copiesOf(device, "Ideas/legal");
    expect(copies, "one copy, in the note's own folder").toHaveLength(1);
    const name = copies[0].slice("Ideas/".length);
    expect(name, "no slash, colon or other character a file name cannot hold").not.toMatch(/[\\/:*?"<>|]/);
    expect(device.vault.textOf(copies[0])).toBe("one\nLOCAL\n");
  });
});
