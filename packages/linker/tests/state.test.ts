// The state note's text: a line for each failed note, read back as it was written, changed one line at a time, and the rest of the note
// left as a person wrote it. And the way the note is changed when another run changes it first.

import { describe, expect, it } from "vitest";
import { EMPTY_STATE, failureOf, failuresIn, lineOf, StateError, StateNote, withFailure, withoutFailure, type Failure } from "../src/state";
import type { NoteContent, NoteRef, NoteStore, SaveResult } from "../src/store";

const AT = "2026-11-16T09:30:00.000Z";
const failure = (more: Partial<Failure> = {}): Failure => ({ id: "7JfCv0aTq2mGx5Zb1nWk4A", tries: 2, at: AT, reason: "The model answered with status 503.", path: "Hush/One.md", ...more });

describe("a line of the state note", () => {
  it("is read back as it was written, whatever the path holds", () => {
    for (const path of ["Hush/One.md", "Hush/A | B - C.md", "Hush/ends with a bar |.md", "Hush/2026 - [[x]] `y` # z.md"]) {
      expect(failureOf(lineOf(failure({ path }))), path).toEqual(failure({ path }));
    }
  });

  it("has a reason that cannot break the line, and a path that cannot run on to the next", () => {
    const line = lineOf(failure({ reason: "one | two\nthree", path: "Hush/a\nb.md" }));
    expect(line.split("\n")).toHaveLength(1);
    expect(failureOf(line)).toEqual(failure({ reason: "one / two three", path: "Hush/a b.md" }));
  });

  it("is not a failure when it is not in that form: a person's own words stay theirs", () => {
    for (const line of ["", "# Linker state", "A is the one with the bad audio.", "- a note | failed many | x | y | z", "- id | failed 1", "- | failed 1 | at | why | path"]) {
      expect(failureOf(line), line).toBeNull();
    }
  });
});

describe("the failures a state note holds", () => {
  it("are by note id, in the order of the lines, and the first line of a note is the one that counts", () => {
    const text = [EMPTY_STATE, lineOf(failure({ id: "b", tries: 1 })), "Some words.", lineOf(failure({ id: "a", tries: 4 })), lineOf(failure({ id: "b", tries: 9 }))].join("\n");
    expect([...failuresIn(text)].map(([id, one]) => [id, one.tries])).toEqual([["b", 1], ["a", 4]]);
  });

  it("are none in a state note with nothing in it, or in no text at all", () => {
    expect(failuresIn(EMPTY_STATE).size).toBe(0);
    expect(failuresIn("").size).toBe(0);
  });
});

describe("changing the text", () => {
  const note = { id: "n1", path: "Hush/One.md" };

  it("adds a line for a note that has none, after the lines there are, and counts the first failure as 1", () => {
    const first = withFailure(EMPTY_STATE, note, "Why.", AT);
    expect(first.startsWith(EMPTY_STATE)).toBe(true);
    expect(first.endsWith(`- n1 | failed 1 | ${AT} | Why. | Hush/One.md\n`)).toBe(true);
    const second = withFailure(first, { id: "n2", path: "Hush/Two.md" }, "Because.", AT);
    expect(second.startsWith(first)).toBe(true);
    expect([...failuresIn(second).keys()]).toEqual(["n1", "n2"]);
  });

  it("raises the count on the line a note has, from the count the text holds now, and keeps the rest of the text", () => {
    const text = `${EMPTY_STATE}Words of a person.\n${lineOf(failure({ id: "n1", tries: 3 }))}\nMore words.\n`;
    const next = withFailure(text, note, "A new reason.", "2026-11-17T00:00:00.000Z");
    expect(failuresIn(next).get("n1")).toEqual({ id: "n1", tries: 4, at: "2026-11-17T00:00:00.000Z", reason: "A new reason.", path: "Hush/One.md" });
    expect(next).toBe(`${EMPTY_STATE}Words of a person.\n- n1 | failed 4 | 2026-11-17T00:00:00.000Z | A new reason. | Hush/One.md\nMore words.\n`);
  });

  it("makes a line in a note a person emptied", () => {
    expect(withFailure("", note, "Why.", AT)).toBe(`- n1 | failed 1 | ${AT} | Why. | Hush/One.md\n`);
  });

  it("takes a note's line out and no other", () => {
    const text = `${EMPTY_STATE}${lineOf(failure({ id: "a" }))}\nWords.\n${lineOf(failure({ id: "b" }))}\n`;
    expect(withoutFailure(text, "a")).toBe(`${EMPTY_STATE}Words.\n${lineOf(failure({ id: "b" }))}\n`);
    expect(withoutFailure(text, "c")).toBe(text);
  });
});

/** A vault that holds one note, which another run changes just before this one saves: `rivals` times in a row. */
function crowdedStore(rivals: number) {
  const notes = new Map<string, { path: string; version: number; text: string }>();
  let rivalSaves = 0;
  const store: NoteStore = {
    listNotes: async (): Promise<NoteRef[]> => [...notes].map(([id, note]) => ({ id, path: note.path, version: note.version })),
    readNote: async (id): Promise<NoteContent> => ({ id, ...notes.get(id)! }),
    createNote: async (path, text) => {
      notes.set("state", { path, version: 1, text });
      return { id: "state", path, version: 1 };
    },
    updateNote: async (id, version, text): Promise<SaveResult> => {
      const note = notes.get(id)!;
      if (rivalSaves < rivals) {
        // The other run's save comes first: its line is in the note, and the note is a version on.
        rivalSaves++;
        note.text = withFailure(note.text, { id: `rival-${rivalSaves}`, path: `Pod/${rivalSaves}.md` }, "Theirs.", AT);
        note.version++;
      }
      if (note.version !== version) return { result: "changed-since" };
      Object.assign(note, { text, version: version + 1 });
      return { result: "saved", version: version + 1 };
    },
  };
  return { store, notes };
}

describe("the state note in a vault", () => {
  const mine = { id: "n1", path: "Hush/One.md" };

  it("is made when there is none, and its lines are read back", async () => {
    const { store } = crowdedStore(0);
    const state = new StateNote(store, "Linker/State.md");
    expect((await state.load(await store.listNotes())).size).toBe(0);
    await state.failed(mine, "Why.", new Date(AT));
    await state.failed(mine, "Why again.", new Date(AT));
    const again = new StateNote(store, "Linker/State.md");
    expect([...(await again.load(await store.listNotes())).values()]).toEqual([{ id: "n1", tries: 2, at: AT, reason: "Why again.", path: "Hush/One.md" }]);
  });

  it("makes its change again on the note as the other run left it, so neither run's line is lost", async () => {
    const { store, notes } = crowdedStore(3);
    const state = new StateNote(store, "Linker/State.md");
    await state.failed({ id: "first", path: "Hush/First.md" }, "Why.", new Date(AT));
    await state.failed(mine, "Why.", new Date(AT));
    expect([...failuresIn(notes.get("state")!.text).keys()]).toEqual(["first", "rival-1", "rival-2", "rival-3", "n1"]);
  });

  it("gives up with a plain message when the note is never left alone long enough to save", async () => {
    const { store } = crowdedStore(1000);
    const state = new StateNote(store, "Linker/State.md");
    await state.failed({ id: "first", path: "Hush/First.md" }, "Why.", new Date(AT));
    const failing = state.failed(mine, "Why.", new Date(AT));
    await expect(failing).rejects.toThrow(StateError);
    await expect(failing).rejects.toThrow("The state note was changed by another run every time it was tried.");
  });
});
