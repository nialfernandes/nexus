// What the job never does. A model that fails, answers garbage or takes too long leaves the note as it was, to be tried next run. A note
// edited between being read and being saved is left alone. At most N notes are taken on a run. Nothing is deleted, and no note outside
// Mentions/ changes except by the section and the one line.

import { afterEach, describe, expect, it } from "vitest";
import { nexusNotes } from "../../../plugin/tests/world";
import { DEFAULT_STATE_NOTE } from "../src/settings";
import { MENTIONS_FOLDER } from "../src/titles";
import { hushPath, transcriptNote } from "./fixtures";
import { listOf, openLab, type Lab } from "./lab";

const labs: Lab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});
async function lab(env: Record<string, string> = {}): Promise<Lab> {
  const opened = await openLab(env);
  labs.push(opened);
  return opened;
}

const BOOK = listOf({ type: "book", title: "Atomic Habits", author: "James Clear" });
const AMAZON = "https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299";

/** What the vault holds apart from the job's own state note, which is the one note a failure writes: the notes the job leaves as they were are these. */
async function vaultWithoutState(l: Lab): Promise<{ texts: Record<string, string>; refs: Awaited<ReturnType<Lab["refs"]>>; state: string | undefined }> {
  const { [DEFAULT_STATE_NOTE]: state, ...texts } = await l.texts();
  return { texts, refs: (await l.refs()).filter((ref) => ref.path !== DEFAULT_STATE_NOTE), state };
}

/** A note with a link in its show notes, so a job that wrote from the links alone, before the model answered, would show. */
const withLink = (name: string, spoken = "He talks about habits.") => transcriptNote({ title: name, description: "Atomic Habits by James Clear.", links: [AMAZON], spoken: [spoken] });

describe("a model that fails", () => {
  const failures: Array<[string, Parameters<Lab["model"]["answer"]>[0], Record<string, string>, RegExp, boolean]> = [
    // The last is whether the failure is the note's, and so written in the state note: an endpoint that is down is not (see failing-notes.test.ts).
    ["answers garbage", () => "Atomic Habits is a great book by James Clear!", {}, /not a JSON list/, true],
    ["answers with an error", () => ({ status: 503 }), {}, /status 503/, false],
    ["answers with an answer of the wrong shape", () => ({ raw: JSON.stringify({ choices: [{ message: { content: null } }] }) }), {}, /no answer/, true],
    ["takes too long", () => ({ delayMs: 2500 }), { LINKER_MODEL_TIMEOUT_SECONDS: "1" }, /did not answer within 1 seconds/, false],
  ];

  for (const [what, handler, env, reason, theNotes] of failures) {
    it(`leaves the note as it was when it ${what}, says why once, and the next run links it`, async () => {
      const l = await lab(env);
      const path = hushPath("One");
      await l.seed(path, withLink("One"));
      const before = { texts: await l.texts(), refs: await l.refs() };

      l.model.answer(handler);
      const failed = await l.run();
      expect(failed.report).toEqual({ linked: [], failed: [{ path, reason: expect.stringMatching(reason) }], changedMeanwhile: [], tried: 1 });
      expect(failed.logs).toHaveLength(1);
      expect(failed.logs[0]).toContain(path);
      expect(failed.logs[0]).toMatch(reason);
      // Not the note, and not a note made from its links either: nothing was written but the line in the state note, and none when the endpoint is what failed.
      const after = await vaultWithoutState(l);
      expect(after.texts).toEqual(before.texts);
      expect(after.refs).toEqual(before.refs);
      if (theNotes) {
        expect(after.state).toContain(`failed 1 | `);
        expect(after.state).toContain(` | ${path}\n`);
      } else {
        expect(after.state).toBeUndefined();
      }

      l.model.answer(() => BOOK);
      const next = await l.run();
      expect(next.report.linked).toEqual([path]);
      expect(next.logs.join("\n")).not.toMatch(/not linked/);
      expect((await l.texts())[path]).toContain("- [[Atomic Habits]]\n");
    });
  }

  it("leaves a long note as it was when the model fails on a later part of it", async () => {
    const l = await lab({ LINKER_MODEL_WINDOW_CHARS: "500" });
    const path = hushPath("Long");
    const spoken = Array.from({ length: 6 }, (_, at) => `Paragraph ${at}. ${"words ".repeat(40)}`);
    await l.seed(path, transcriptNote({ title: "Long", links: [AMAZON], spoken }));
    const before = { texts: await l.texts(), refs: await l.refs() };
    l.model.answer((_, call) => (call === 3 ? "no list here" : BOOK));
    const { report } = await l.run();
    expect(l.model.asked.length).toBeGreaterThanOrEqual(3);
    expect(report.failed).toHaveLength(1);
    const after = await vaultWithoutState(l);
    expect(after.texts).toEqual(before.texts);
    expect(after.refs).toEqual(before.refs);
    expect(after.state).toContain(` | ${path}\n`);

    // A model that works: the note is sent in parts, the lists are joined, and the same book said in two parts is one link.
    l.model.asked.length = 0;
    l.model.answer(() => BOOK);
    const next = await l.run();
    expect(next.report.linked).toEqual([path]);
    expect(l.model.asked.length).toBeGreaterThan(1);
    expect(l.model.asked.every((asked) => asked.body.messages[1]!.content.length <= 500)).toBe(true);
    const text = (await l.texts())[path]!;
    expect(text.match(/\[\[Atomic Habits\]\]/g)).toHaveLength(1);
  });

  it("goes on to the next note after one that failed", async () => {
    const l = await lab();
    await l.seed(hushPath("A bad one"), withLink("A bad one", "bad"));
    await l.seed(hushPath("B good one"), withLink("B good one", "good"));
    l.model.answer((transcript) => (transcript.includes("bad") ? "garbage" : BOOK));
    const { report } = await l.run();
    expect(report.failed.map((one) => one.path)).toEqual([hushPath("A bad one")]);
    expect(report.linked).toEqual([hushPath("B good one")]);
  });
});

describe("a note edited between being read and being saved", () => {
  it("is left alone this run, and linked next run with the edit kept", async () => {
    const l = await lab();
    const path = hushPath("One");
    const text = withLink("One");
    const made = await l.seed(path, text);
    const edited = `${text}\nA line a person added while the model was thinking.\n`;
    let once = true;
    l.model.answer(async () => {
      if (once) {
        once = false;
        expect(await l.writer.updateNote(made.id, made.version, edited)).toMatchObject({ result: "saved", version: 2 });
      }
      return BOOK;
    });

    const first = await l.run();
    expect(first.report).toEqual({ linked: [], failed: [], changedMeanwhile: [path], tried: 1 });
    expect(first.logs).toEqual([expect.stringContaining(path)]);
    expect(first.logs[0]).toMatch(/edited/);
    // The person's text is what is there: not overwritten, not merged, not marked.
    expect((await l.texts())[path]).toBe(edited);
    expect((await l.refs()).find((ref) => ref.path === path)!.version).toBe(2);

    // The next run finds it, as a note at a later version, and links it with the person's line still in it.
    const next = await l.run();
    expect(next.report.linked).toEqual([path]);
    const texts = await l.texts();
    expect(texts[path]).toContain("A line a person added while the model was thinking.");
    expect(texts[path]).toContain("mentions: linked");
    expect(texts[path]).toContain("- [[Atomic Habits]]\n");
    // What the first run made is used by the second, not made again.
    expect(Object.keys(texts).filter((one) => one.startsWith(MENTIONS_FOLDER)).sort()).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
  });

  it("is found by the next run only while it is among the newest notes the run reads, and not at all when the job is told to read none", async () => {
    const l = await lab({ LINKER_MAX_CHECKS: "0" });
    const path = hushPath("Edited first");
    const made = await l.seed(path, withLink("Edited first"));
    await l.writer.updateNote(made.id, made.version, `${withLink("Edited first")}\nEdited.\n`);
    l.model.answer(() => BOOK);
    expect((await l.run()).report.tried).toBe(0);
    expect((await l.run({ LINKER_MAX_CHECKS: "5" })).report.linked).toEqual([path]);
  });
});

describe("how many notes a run takes on", () => {
  it("is at most the setting, the first by path first, and the rest are taken on by the next runs", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "2" });
    const paths = ["A", "B", "C", "D", "E"].map((name) => hushPath(name));
    for (const path of paths) await l.seed(path, transcriptNote({ title: path, spoken: ["Words."] }));
    l.model.answer(() => "[]");

    expect((await l.run()).report.linked).toEqual(paths.slice(0, 2));
    expect(l.model.asked).toHaveLength(2);
    expect((await l.run()).report.linked).toEqual(paths.slice(2, 4));
    expect((await l.run()).report.linked).toEqual(paths.slice(4));
    expect((await l.run()).report.tried).toBe(0);
    expect(l.model.asked).toHaveLength(5);
  });

  it("is ten when it is not set", async () => {
    const l = await lab();
    const paths = Array.from({ length: 12 }, (_, at) => hushPath(`N${String(at).padStart(2, "0")}`));
    for (const path of paths) await l.seed(path, transcriptNote({ title: path, spoken: ["Words."] }));
    l.model.answer(() => "[]");
    expect((await l.run()).report.linked).toHaveLength(10);
    expect((await l.run()).report.linked).toHaveLength(2);
  });

  it("counts a note that failed, so a model that keeps failing is not asked more than the setting a run", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "2" });
    for (const name of ["A", "B", "C"]) await l.seed(hushPath(name), transcriptNote({ title: name, spoken: ["Words."] }));
    l.model.answer(() => "garbage");
    const { report } = await l.run();
    expect(report.failed).toHaveLength(2);
    expect(l.model.asked).toHaveLength(2);
  });
});

describe("how much one run reads and one note takes", () => {
  it("links a note that mentions a great deal to the first hundred things, and says so", async () => {
    const l = await lab({ LINKER_MODEL_WINDOW_CHARS: "500" });
    const path = hushPath("Everything");
    await l.seed(path, transcriptNote({ title: "Everything", spoken: ["a ".repeat(200), "b ".repeat(200)] }));
    // Sixty people a part is as many as an answer is read for, and the note has two parts.
    l.model.answer((_, call) => listOf(...Array.from({ length: 70 }, (_, at) => ({ type: "person", title: `Person ${call}-${at}` }))));
    const { report, logs } = await l.run();
    expect(l.model.asked).toHaveLength(2);
    expect(report.linked).toEqual([path]);
    expect(logs).toEqual([`${path}: mentions 120 things, so it is linked to the first 100`, `${path}: linked to 100 things`]);
    const texts = await l.texts();
    expect(Object.keys(texts).filter((one) => one.startsWith(MENTIONS_FOLDER))).toHaveLength(100);
    expect(texts[path]!.match(/^- \[\[/gm)).toHaveLength(100);
  });

  it("reads no more notes in a run than its two limits allow between them", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "1", LINKER_MAX_CHECKS: "1" });
    // Notes at their first version that say they are linked already: read, found done, and not counted as taken on.
    for (const name of ["A", "B", "C"]) await l.seed(hushPath(name), "---\nmentions: linked\n---\n");
    await l.seed(hushPath("D fresh"), transcriptNote({ title: "D fresh", spoken: ["Words."] }));
    l.model.answer(() => "[]");
    // Two reads, both of notes that were done: the fresh note is not reached.
    expect((await l.run()).report.tried).toBe(0);
    expect(l.model.asked).toHaveLength(0);
    // With room to read a third and a fourth, it is.
    expect((await l.run({ LINKER_MAX_CHECKS: "3" })).report.linked).toEqual([hushPath("D fresh")]);
  });
});

describe("what is never touched", () => {
  it("is every note outside the folders, every note already linked and every note in Mentions/, and nothing is deleted", async () => {
    const l = await lab();
    const aside = {
      "Daily/2026-11-10.md": "Today I read https://www.amazon.com/Atomic-Habits/dp/0735211299 and Atomic Habits.\n",
      "Notes/elsewhere.md": transcriptNote({ title: "elsewhere", spoken: ["Atomic Habits by James Clear."] }),
      [hushPath("Already")]: "---\nmentions: linked\n---\n\n## Mentions\n\n- [[Gone Girl]]\n\n## Transcript\n\n[0:00] Atomic Habits.\n",
      "Mentions/Mine.md": "---\ntype: book\n---\nMy note.\n",
      "Hush-not/2026.md": "Not in the folder, only named like it.\n",
    };
    for (const [path, text] of Object.entries(aside)) await l.seed(path, text);
    await l.seed(hushPath("New"), withLink("New"));
    const before = await l.refs();
    l.model.answer(() => BOOK);

    const { report } = await l.run();
    expect(report.linked).toEqual([hushPath("New")]);
    expect(l.model.asked).toHaveLength(1);

    const after = await l.refs();
    // Every note that was there is there, and the notes that were set aside are at the version they were at, with the text they had.
    expect(after.map((ref) => ref.path)).toEqual(expect.arrayContaining(before.map((ref) => ref.path)));
    const texts = await l.texts();
    for (const [path, text] of Object.entries(aside)) {
      expect(after.find((ref) => ref.path === path), path).toEqual(before.find((ref) => ref.path === path));
      expect(texts[path], path).toBe(text);
    }
    // The job never asked Nexus to delete.
    expect(l.seen.filter((call) => call.route === "delete")).toEqual([]);
    // It saved a note for each of the book, its author and the one transcript note, and nothing more.
    expect(l.seen.filter((call) => call.route === "save" && call.status === 200).length - before.length).toBe(3);
  });

  it("is the whole of a transcript note but the section and the one line, which are all that is added to it", async () => {
    const l = await lab();
    const path = hushPath("Exact");
    const original = transcriptNote({ title: "Exact", description: "Some words.\nWith two lines.", links: ["https://b.example/page"], spoken: ["One.", "Two.", "Three."] }).replace(/\n/g, "\r\n");
    await l.seed(path, original);
    l.model.answer(() => listOf({ type: "person", title: "Ada Lovelace" }));
    await l.run();
    const linked = (await l.texts())[path]!;
    expect(linked.replace("mentions: linked\r\n", "").replace("## Mentions\r\n\r\n- [[b.example page]]\r\n- [[Ada Lovelace]]\r\n\r\n", "")).toBe(original);
  });
});

describe("two runs started together", () => {
  /** A model that answers only once both runs have asked it, so both have looked at the vault before either has made a note. */
  function bothAsk(l: Lab, answerFor: (call: number) => string): void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    l.model.answer(async (_, call) => {
      if (l.model.asked.length >= 2) release();
      await gate;
      return answerFor(call);
    });
  }

  /** The notes in Mentions/, counted by the id Nexus holds them under, so two notes at one path are two. */
  async function mentionNotes(l: Lab): Promise<Array<{ path: string; text: string }>> {
    return Object.values(await nexusNotes(l.world)).filter((note) => note.path.startsWith(MENTIONS_FOLDER));
  }

  it("make one note for a thing, not two, and the transcript note is linked once", async () => {
    const l = await lab();
    const path = hushPath("One");
    await l.seed(path, withLink("One"));
    bothAsk(l, () => BOOK);
    const [a, b] = await Promise.all([l.run(), l.run()]);
    expect(l.model.asked).toHaveLength(2);
    // Each saved its Mentions notes; only one could save the transcript note, at the version both read.
    expect([...a.report.linked, ...b.report.linked]).toEqual([path]);
    expect([...a.report.changedMeanwhile, ...b.report.changedMeanwhile]).toEqual([path]);
    expect([...a.report.failed, ...b.report.failed]).toEqual([]);

    expect((await mentionNotes(l)).map((note) => note.path).sort()).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    expect((await l.texts())[path]).toContain("- [[Atomic Habits]]\n");
    // The next run finds it linked, and changes nothing.
    const before = await l.refs();
    expect((await l.run()).report.tried).toBe(0);
    expect(await l.refs()).toEqual(before);
  });

  it("make one note when they name the thing in different capitals, and link to the note that is there", async () => {
    const l = await lab();
    const path = hushPath("One");
    await l.seed(path, transcriptNote({ title: "One", spoken: ["Said."] }));
    // One run hears "the atomic habits", the other "Atomic Habits.": two paths, one title.
    bothAsk(l, (call) => listOf({ type: "book", title: call === 1 ? "the atomic habits" : "Atomic Habits.", ...(call === 1 ? {} : { author: "James Clear" }) }));
    const [a, b] = await Promise.all([l.run(), l.run()]);
    expect([...a.report.failed, ...b.report.failed]).toEqual([]);

    const notes = await mentionNotes(l);
    const books = notes.filter((note) => /^Mentions\/(the )?atomic habits/i.test(note.path));
    expect(books).toHaveLength(1);
    const name = books[0]!.path.slice(MENTIONS_FOLDER.length, -".md".length);
    // Whichever run's name won, the transcript note links to a note that exists.
    expect((await l.texts())[path]).toContain(`- [[${name}]]\n`);
    expect(notes.filter((note) => note.path === "Mentions/James Clear.md")).toHaveLength(1);
  });
});
