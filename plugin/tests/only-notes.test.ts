// Only notes are synced: markdown files outside the `.obsidian` folder. The plugin's own settings (which hold the
// token), every other file in `.obsidian`, and attachments are never read, never sent, and never written from what
// Nexus holds, in either direction and whichever way the sync starts. Against the in-memory Nexus (see world.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_PAUSE, emptyNexus, fakeTimers, forbidFetch, makeDevice, nexusTexts, openWorld, syncedDevice, type World } from "./world";

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

/** Files that are not notes, in the places a vault keeps them. The settings file holds a marker where the token would be. */
const NOT_NOTES: Record<string, string> = {
  ".obsidian/app.json": '{"theme":"obsidian"}\n',
  ".obsidian/plugins/nexus/data.json": '{"token":"MARKER-TOKEN-TEXT"}\n',
  ".obsidian/snippets/tidy.md": "a markdown file inside .obsidian is still not a note\n",
  "Attachments/photo.png": "MARKER-PNG-BYTES",
  "Attachments/scan.pdf": "MARKER-PDF-BYTES",
  "Ideas/board.canvas": '{"nodes":[]}\n',
  "Ideas/readme": "no extension at all\n",
};

describe("only notes", () => {
  it("are sent by the first sync: nothing from .obsidian or the attachments is read or sent", async () => {
    const device = await makeDevice(world, { files: { "Ideas/a.md": "a note\n", ...NOT_NOTES } });
    await device.engine.sync();

    expect(await nexusTexts(world), "Nexus holds the one note").toEqual({ "Ideas/a.md": "a note\n" });
    const everythingSent = JSON.stringify(device.log.requests().map((r) => [r.method, r.route, r.query, r.body]));
    for (const marker of ["MARKER-TOKEN-TEXT", "MARKER-PNG-BYTES", "MARKER-PDF-BYTES", ".obsidian", "Attachments", "board.canvas"]) {
      expect(everythingSent, `no request carries ${marker}`).not.toContain(marker);
    }
    expect(device.log.reads().filter((p) => p !== "Ideas/a.md"), "and nothing but the note is read").toEqual([]);
    expect(Object.keys(device.data().notes)).toEqual(["Ideas/a.md"]);
    expect(device.vault.texts(), "the vault's other files are as they were").toEqual({ "Ideas/a.md": "a note\n", ...NOT_NOTES });
  });

  it("are sent by edits, renames and deletes: the same files in the vault's events send nothing", async () => {
    fakeTimers();
    const device = await syncedDevice(world, { "Ideas/a.md": "a note\n", ...NOT_NOTES });
    const quietFrom = device.log.timeline.length;

    for (const path of Object.keys(NOT_NOTES)) {
      device.engine.edited(path);
      await device.engine.push(path);
      await device.engine.deleted(path);
      await device.engine.renamed(path, `${path}.moved`);
    }
    await device.engine.renamed("Attachments/photo.png", "Attachments/holiday.png");
    await device.engine.renamed(".obsidian/snippets/tidy.md", ".obsidian/snippets/neat.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE * 2);

    expect(device.log.timeline.slice(quietFrom).filter((s) => s.kind === "request"), "not one request").toEqual([]);

    // The same events for a note do send, so the quiet above is not an engine that sends nothing at all.
    device.vault.type("Ideas/a.md", "a note, edited\n");
    device.engine.edited("Ideas/a.md");
    await vi.advanceTimersByTimeAsync(EDIT_PAUSE);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await nexusTexts(world)).toEqual({ "Ideas/a.md": "a note, edited\n" }));
  });

  it("are all that comes down: a note arrives, a file in .obsidian or an attachment never does", async () => {
    await world.elsewhere.create("Ideas/ok.md", "a note\n");
    await world.elsewhere.create(".obsidian/plugins/evil/main.js", "run this on the phone\n");
    const settings = await world.elsewhere.create(".obsidian/app.json", "{}\n");
    await world.elsewhere.create(".obsidian/snippets/tidy.md", "markdown, but inside .obsidian\n");
    await world.elsewhere.create("Attachments/x.png", "pretend bytes\n");

    const fresh = await makeDevice(world, { files: { "Mine/local.md": "mine\n" } });
    await fresh.engine.sync();
    expect(fresh.vault.texts(), "a first sync brings down the note and only the note").toEqual({
      "Ideas/ok.md": "a note\n",
      "Mine/local.md": "mine\n",
    });
    expect(fresh.engine.status(), "the files that are not notes are passed over without a word").toMatch(/last synced/i);

    const device = await syncedDevice(world, { "Ideas/ok.md": "a note\n", ".obsidian/app.json": '{"theme":"obsidian"}\n' });
    await world.elsewhere.create(".obsidian/plugins/evil2/main.js", "run this too\n");
    await world.elsewhere.create("Attachments/y.png", "more pretend bytes\n");
    await world.elsewhere.create("Ideas/later.md", "a later note\n");
    await world.elsewhere.update(settings.id, ".obsidian/app.json", "{ }\n");
    await world.elsewhere.remove(settings.id);
    await device.engine.sync();

    expect(device.vault.texts(), "a pull brings down the note and only the note, and removes nothing outside the notes").toEqual({
      "Ideas/ok.md": "a note\n",
      "Ideas/later.md": "a later note\n",
      "Mine/local.md": "mine\n",
      ".obsidian/app.json": '{"theme":"obsidian"}\n',
    });
    expect(device.engine.status()).toMatch(/last synced/i);
  });
});
