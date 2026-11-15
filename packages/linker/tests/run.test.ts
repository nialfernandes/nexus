// The parts of a run that can be shown without a vault: which notes are looked at and in what order, how the two sources' lists are joined,
// and what a run says when something it did not expect goes wrong.

import { describe, expect, it } from "vitest";
import { joined, notesToLookAt, runLinker } from "../src/run";
import { readSettings } from "../src/settings";
import type { NoteContent, NoteRef, NoteStore } from "../src/store";
import { hushPath, transcriptNote } from "./fixtures";

const ref = (path: string, version = 1): NoteRef => ({ id: `id-${path}`, path, version });

describe("notesToLookAt", () => {
  it("is the notes at their first version by path, then the later ones newest first, and only in the folders", () => {
    const refs = [
      ref("Hush/2026_11_03 - c.md"),
      ref("Hush/2026_11_01 - a.md", 3),
      ref("Hush/2026_11_02 - b.md"),
      ref("Hush/2026_11_04 - d.md", 2),
      ref("Podcasts/x.md"),
      ref("Mentions/Atomic Habits.md"),
      ref("Hush/2026_11_05 - not a note.txt"),
      ref("Hushed/2026.md"),
    ];
    expect(notesToLookAt(refs, ["Hush/", "Podcasts/"]).map((one) => one.path)).toEqual([
      "Hush/2026_11_02 - b.md",
      "Hush/2026_11_03 - c.md",
      "Podcasts/x.md",
      "Hush/2026_11_04 - d.md",
      "Hush/2026_11_01 - a.md",
    ]);
  });

  it("is nothing for a folder with no note in it", () => {
    expect(notesToLookAt([ref("Daily/a.md")], ["Hush/"])).toEqual([]);
  });
});

describe("joined", () => {
  it("keeps a thing found twice once, with the author and address either source had", () => {
    expect(
      joined([
        [{ type: "book", title: "Atomic Habits", url: "https://www.amazon.com/dp/0735211299" }, { type: "website", title: "b.example" }],
        [{ type: "book", title: "the atomic habits.", author: "James Clear", url: "https://other.example/" }, { type: "person", title: "Ada" }],
      ]),
    ).toEqual([
      { type: "book", title: "Atomic Habits", url: "https://www.amazon.com/dp/0735211299", author: "James Clear" },
      { type: "website", title: "b.example" },
      { type: "person", title: "Ada" },
    ]);
  });

  it("does not change the lists it is given", () => {
    const first = [{ type: "book" as const, title: "A" }];
    joined([first, [{ type: "book", title: "a", author: "X" }]]);
    expect(first).toEqual([{ type: "book", title: "A" }]);
  });
});

describe("a run that meets something it did not expect", () => {
  it("says only what kind of thing it was, and goes on to the next note", async () => {
    const texts = new Map<string, string>([
      ["a", transcriptNote({ title: "a", spoken: [] })],
      ["b", transcriptNote({ title: "b", spoken: [] })],
    ]);
    const store: NoteStore = {
      listNotes: async () => [ref(hushPath("a")), ref(hushPath("b"))].map((one, at) => ({ ...one, id: ["a", "b"][at]! })),
      readNote: async (id): Promise<NoteContent> => ({ id, path: hushPath(id), version: 1, text: texts.get(id)! }),
      createNote: async () => {
        throw new Error("never made");
      },
      updateNote: async (id) => {
        if (id === "a") throw new TypeError("a message with a secret-token-value in it");
        return { result: "saved", version: 2 };
      },
    };
    const logs: string[] = [];
    const settings = readSettings({ LINKER_FOLDERS: "Hush/", LINKER_MODEL_ADDRESS: "http://127.0.0.1:1/v1", LINKER_MODEL_KEY: "k", LINKER_MODEL_NAME: "m" });
    // No spoken words, so the model is never asked: only the show notes are read, and these have no address in them.
    const report = await runLinker({ store, settings, fetchModel: async () => Promise.reject(new Error("not asked")), log: (line) => logs.push(line) });
    expect(report.failed).toEqual([{ path: hushPath("a"), reason: "an unexpected TypeError" }]);
    expect(report.linked).toEqual([hushPath("b")]);
    expect(logs.join("\n")).not.toContain("secret-token-value");
  });
});
