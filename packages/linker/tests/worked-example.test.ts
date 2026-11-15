// The worked example, against the real server code and a stand-in model server. Two transcript notes in Hush/ both mention Atomic Habits
// by James Clear: one by an Amazon link in its show notes, one only out loud. After one run there is one note for the book and one for its
// author, each transcript note links to the book and says it was linked, and a second run changes nothing and asks the model nothing.

import { afterEach, describe, expect, it } from "vitest";
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

const LINK_NOTE = hushPath("A link in the show notes");
const SPOKEN_NOTE = hushPath("B said out loud");
const AMAZON = "https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299?tag=a-tag";

const linkNote = transcriptNote({
  title: "A link in the show notes",
  description: "Our book this week: Atomic Habits by James Clear.",
  links: [AMAZON],
  spoken: ["Welcome back to the show.", "Today we read a book about small changes."],
});
const spokenNote = transcriptNote({
  title: "B said out loud",
  description: "A chat about getting better.",
  spoken: ["I keep coming back to Atomic Habits by James Clear.", "It changed how I think about routines."],
});

/** A model that hears Atomic Habits in a transcript that says it. */
const listens = (transcript: string): string => (transcript.includes("Atomic Habits") ? listOf({ type: "book", title: "Atomic Habits", author: "James Clear" }) : "[]");

const without = (text: string, section: string): string => text.replace("\nmentions: linked", "").replace(section, "");

describe("the worked example", () => {
  it("links two transcript notes to one note for the book and one for its author, and a second run changes nothing", async () => {
    const l = await lab();
    await l.seed(LINK_NOTE, linkNote);
    await l.seed(SPOKEN_NOTE, spokenNote);
    l.model.answer(listens);

    const first = await l.run();
    expect(first.report).toEqual({ linked: [LINK_NOTE, SPOKEN_NOTE], failed: [], changedMeanwhile: [], tried: 2 });

    const texts = await l.texts();
    const paths = Object.keys(texts).sort();
    // One note each for the book and its author, and nothing else in the folder.
    expect(paths.filter((path) => path.startsWith(MENTIONS_FOLDER))).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    expect(paths).toHaveLength(4);

    const book = texts["Mentions/Atomic Habits.md"]!;
    expect(book).toMatch(/^---\ntype: book\n/);
    expect(book).toContain('author: "[[James Clear]]"');
    // The address of the page, kept without the tracking that came with it: it came from the show notes of the first note.
    expect(book).toContain('url: "https://www.amazon.com/dp/0735211299"');
    expect(texts["Mentions/James Clear.md"]).toBe("---\ntype: person\n---\n");

    for (const [path, original] of [[LINK_NOTE, linkNote], [SPOKEN_NOTE, spokenNote]] as const) {
      const linked = texts[path]!;
      expect(linked, path).toContain("\n## Mentions\n\n- [[Atomic Habits]]\n");
      expect(linked, path).toMatch(/^---\n[\s\S]*\nmentions: linked\n---\n/);
      // The note changed by the section and the one line, and nothing else.
      expect(without(linked, "## Mentions\n\n- [[Atomic Habits]]\n\n"), path).toBe(original);
    }

    // One call to the model for each transcript note, with the key and the model name that are the job's settings.
    expect(l.model.asked).toHaveLength(2);
    expect(l.model.asked.every((asked) => asked.authorization === "Bearer a-key-for-the-stand-in" && asked.body.model === "a-model-name")).toBe(true);
    // The model is read the spoken words, not the front matter and not the times.
    const heard = l.model.asked.map((asked) => asked.body.messages[1]!.content);
    expect(heard[0]).toBe("Welcome back to the show.\n\nToday we read a book about small changes.");
    expect(heard.join("")).not.toContain("hush");
    expect(heard.join("")).not.toMatch(/\[\d+:\d{2}\]/);

    // A second run: no note changes, no note is made, and the model is not asked.
    const before = await l.refs();
    const second = await l.run();
    expect(second.report).toEqual({ linked: [], failed: [], changedMeanwhile: [], tried: 0 });
    expect(await l.refs()).toEqual(before);
    expect(await l.texts()).toEqual(texts);
    expect(l.model.asked).toHaveLength(2);
  });

  it("gives the same result when the spoken note comes first, because the author is added to the book when it is found", async () => {
    const l = await lab();
    // The spoken note is the earlier by path here.
    await l.seed(hushPath("A said out loud"), spokenNote);
    await l.seed(hushPath("B link"), linkNote);
    l.model.answer(listens);
    await l.run();
    const texts = await l.texts();
    expect(Object.keys(texts).filter((path) => path.startsWith(MENTIONS_FOLDER)).sort()).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    const book = texts["Mentions/Atomic Habits.md"]!;
    expect(book).toContain('author: "[[James Clear]]"');
    expect(book).toContain('url: "https://www.amazon.com/dp/0735211299"');
    expect(book.match(/^type:/gm)).toHaveLength(1);
  });

  it("makes a note of every kind: a website, a quote, a person, and a book's own author", async () => {
    const l = await lab();
    await l.seed(
      hushPath("Kinds"),
      transcriptNote({ title: "Kinds", links: ["https://jamesclear.com/atomic-habits?utm_source=news"], spoken: ["Everything is said here."] }),
    );
    const quote = "You do not rise to the level of your goals. You fall to the level of your systems and then some more words.";
    // Cut at a word, at most 80 characters.
    const quoteName = "You do not rise to the level of your goals. You fall to the level of your";
    l.model.answer(() =>
      listOf(
        { type: "website", title: "Hacker News", url: "news.ycombinator.com" },
        { type: "quote", title: quote, author: "James Clear" },
        { type: "person", title: "Ada Lovelace" },
        { type: "book", title: "Deep Work", author: "Cal Newport" },
        { type: "book", title: "../../Not A Path [[x]]" },
        { type: "movie", title: "Dropped" },
      ),
    );
    const { report } = await l.run();
    expect(report.linked).toEqual([hushPath("Kinds")]);
    const texts = await l.texts();
    const mentions = Object.entries(texts).filter(([path]) => path.startsWith(MENTIONS_FOLDER));
    expect(mentions.map(([path]) => path).sort()).toEqual([
      "Mentions/Ada Lovelace.md",
      "Mentions/Cal Newport.md",
      "Mentions/Deep Work.md",
      "Mentions/Hacker News.md",
      "Mentions/James Clear.md",
      "Mentions/Not A Path x.md",
      `Mentions/${quoteName}.md`,
      "Mentions/jamesclear.com atomic habits.md",
    ]);
    // The tracking in the address is left off.
    expect(texts["Mentions/jamesclear.com atomic habits.md"]).toBe('---\ntype: website\nurl: "https://jamesclear.com/atomic-habits"\n---\n');
    expect(texts["Mentions/Hacker News.md"]).toBe('---\ntype: website\nurl: "https://news.ycombinator.com/"\n---\n');
    expect(texts["Mentions/Ada Lovelace.md"]).toBe("---\ntype: person\n---\n");
    expect(texts["Mentions/Deep Work.md"]).toBe('---\ntype: book\nauthor: "[[Cal Newport]]"\n---\n');
    // A quote too long for a name is named by its first words and keeps all of them as its text.
    const quoteNote = texts[`Mentions/${quoteName}.md`]!;
    expect(quoteNote).toBe(`---\ntype: quote\nauthor: "[[James Clear]]"\n---\n\n> ${quote}\n`);
    // The transcript note links to what it mentions, and not to a person who is only an author.
    const linked = texts[hushPath("Kinds")]!;
    expect(linked).toContain("- [[jamesclear.com atomic habits]]\n- [[Hacker News]]\n- [[You do not rise");
    expect(linked).toContain("- [[Not A Path x]]\n");
    expect(linked).not.toContain("- [[Cal Newport]]");
  });
});

describe("one thing, one note", () => {
  it("lands 'the atomic habits' and 'Atomic Habits.' on the same note, and a note already there is used and not made again", async () => {
    const l = await lab();
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["First, one way of saying it."] }));
    await l.seed(hushPath("Two"), transcriptNote({ title: "Two", spoken: ["Second, another way of saying it."] }));
    l.model.answer((transcript) => listOf({ type: "book", title: transcript.startsWith("First") ? "the atomic habits" : "Atomic Habits." }));
    await l.run();
    const texts = await l.texts();
    const notes = Object.keys(texts).filter((path) => path.startsWith(MENTIONS_FOLDER));
    // The first note's title names the note; the second finds it.
    expect(notes).toEqual(["Mentions/the atomic habits.md"]);
    for (const name of ["One", "Two"]) expect(texts[hushPath(name)]).toContain("- [[the atomic habits]]\n");
  });

  it("uses the note a person made, whatever its case, and adds the author it lacked and nothing it had", async () => {
    const l = await lab();
    await l.seed("Mentions/Atomic Habits.md", "---\ntype: book\nrating: 5\n---\nMy own words about it.\n");
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Said."] }));
    l.model.answer(() => listOf({ type: "book", title: "THE ATOMIC HABITS", author: "James Clear", url: "https://example.org/book" }));
    await l.run();
    const texts = await l.texts();
    expect(Object.keys(texts).filter((path) => path.startsWith(MENTIONS_FOLDER)).sort()).toEqual(["Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    expect(texts["Mentions/Atomic Habits.md"]).toBe('---\ntype: book\nrating: 5\nauthor: "[[James Clear]]"\nurl: "https://example.org/book"\n---\nMy own words about it.\n');
    expect(texts[hushPath("One")]).toContain("- [[Atomic Habits]]\n");
  });

  it("does not change a note that has the author and the address already", async () => {
    const l = await lab();
    const own = '---\ntype: book\nauthor: "[[J. Clear]]"\nurl: "https://own.example/"\n---\n';
    const made = await l.seed("Mentions/Atomic Habits.md", own);
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Said."] }));
    l.model.answer(() => listOf({ type: "book", title: "Atomic Habits", author: "James Clear", url: "https://example.org/book" }));
    await l.run();
    expect((await l.refs()).find((ref) => ref.path === "Mentions/Atomic Habits.md")).toEqual(made);
    expect((await l.texts())["Mentions/Atomic Habits.md"]).toBe(own);
  });

  it("finds a book that a bookshop's address names with its subtitle under the shorter title it was spoken by", async () => {
    const l = await lab();
    await l.seed("Mentions/Atomic Habits.md", "---\ntype: book\n---\n");
    await l.seed(hushPath("One"), transcriptNote({ title: "One", description: "A read.", links: [AMAZON], spoken: ["Nothing here."] }));
    l.model.answer(() => "[]");
    await l.run();
    const texts = await l.texts();
    expect(Object.keys(texts).filter((path) => path.startsWith(MENTIONS_FOLDER))).toEqual(["Mentions/Atomic Habits.md"]);
    expect(texts["Mentions/Atomic Habits.md"]).toBe('---\ntype: book\nurl: "https://www.amazon.com/dp/0735211299"\n---\n');
    expect(texts[hushPath("One")]).toContain("- [[Atomic Habits]]\n");
  });
});
