import { describe, expect, it } from "vitest";
import { fieldOf, hasField, hasFrontMatter, isLinked, linkedText, ownLink, showNotesOf, spokenOf, withFrontLines, withLinkedMark, withMentionsSection } from "../src/note-text";
import { transcriptNote } from "./fixtures";

const note = transcriptNote({
  title: "Habits",
  link: "https://shows.example.org/habits",
  description: "We talk about Atomic Habits by James Clear.",
  links: ["https://www.amazon.com/Atomic-Habits/dp/0735211299"],
  spoken: ["First paragraph, said out loud.", "Second paragraph."],
});

describe("a transcript note linked: what changes and what does not", () => {
  it("gains a Mentions section before the transcript and one front matter line, and nothing else", () => {
    expect(isLinked(note)).toBe(false);
    const linked = linkedText(note, ["Atomic Habits", "James Clear"]);
    expect(isLinked(linked)).toBe(true);
    // Take the two additions out, and the note is the one it was.
    const without = linked.replace("\nmentions: linked", "").replace("## Mentions\n\n- [[Atomic Habits]]\n- [[James Clear]]\n\n", "");
    expect(without).toBe(note);
    expect(linked.indexOf("## Mentions")).toBeGreaterThan(linked.indexOf("## Links"));
    expect(linked.indexOf("## Mentions")).toBeLessThan(linked.indexOf("## Transcript"));
    expect(linked.indexOf("mentions: linked")).toBeLessThan(linked.indexOf("\n---\n", 5));
  });

  it("adds only the line when nothing was found, and no empty section", () => {
    const linked = linkedText(note, []);
    expect(linked).toBe(note.replace("  - transcript\n---", "  - transcript\nmentions: linked\n---"));
    expect(linked).not.toContain("## Mentions");
  });

  it("keeps a note's own line endings", () => {
    const crlf = note.replace(/\n/g, "\r\n");
    const linked = linkedText(crlf, ["Atomic Habits"]);
    expect(linked.replace(/\r\n/g, "")).not.toContain("\n");
    expect(isLinked(linked)).toBe(true);
    expect(linked.replace("mentions: linked\r\n", "").replace("## Mentions\r\n\r\n- [[Atomic Habits]]\r\n\r\n", "")).toBe(crlf);
  });

  it("gives a note with no front matter a front matter of its own, with the one line in it", () => {
    const bare = "Some words.\n\n## Transcript\n\n[0:00] Said.\n";
    const linked = linkedText(bare, ["X"]);
    expect(linked.startsWith("---\nmentions: linked\n---\nSome words.")).toBe(true);
    expect(isLinked(linked)).toBe(true);
    expect(hasFrontMatter(bare)).toBe(false);
  });

  it("puts the section at the end of a note with no transcript heading", () => {
    const linked = withMentionsSection("---\na: 1\n---\nJust words.\n", ["X"]);
    expect(linked).toBe("---\na: 1\n---\nJust words.\n\n## Mentions\n\n- [[X]]\n");
  });

  it("puts a mentions line that said something else right, and does not add a second", () => {
    const text = "---\nmentions: pending\nb: 2\n---\nbody\n";
    expect(withLinkedMark(text)).toBe("---\nmentions: linked\nb: 2\n---\nbody\n");
    expect(withLinkedMark(withLinkedMark(text))).toBe(withLinkedMark(text));
  });

  it("reads quoted forms of the line as linked", () => {
    expect(isLinked('---\nmentions: "linked"\n---\n')).toBe(true);
    expect(isLinked("---\nmentions: 'linked'\n---\n")).toBe(true);
    expect(isLinked("---\nmentions: linked-not\n---\n")).toBe(false);
    expect(isLinked("mentions: linked\n")).toBe(false);
  });
});

describe("a Mentions section that is already there", () => {
  const text = "---\na: 1\n---\n## Mentions\n\n- [[Atomic Habits]]\n- my own line\n\n## Transcript\n\n[0:00] Hi.\n";

  it("keeps every line and gets only the links it lacks, ignoring case and a label", () => {
    const added = withMentionsSection(text, ["atomic habits", "James Clear"]);
    expect(added).toBe(text.replace("- my own line\n", "- my own line\n- [[James Clear]]\n"));
  });

  it("is not changed when it has every link", () => {
    expect(withMentionsSection("## Mentions\n\n- [[Deep Work|the book]]\n", ["Deep Work"])).toBe("## Mentions\n\n- [[Deep Work|the book]]\n");
  });

  it("gets its links when it is empty", () => {
    expect(withMentionsSection("## Mentions\n\n## Transcript\n", ["X"])).toBe("## Mentions\n\n- [[X]]\n\n## Transcript\n");
  });
});

describe("front matter lines", () => {
  it("are added at the end of the block, and read back", () => {
    const text = "---\ntype: book\n---\n";
    const added = withFrontLines(text, ['author: "[[James Clear]]"']);
    expect(added).toBe('---\ntype: book\nauthor: "[[James Clear]]"\n---\n');
    expect(hasField(added, "author")).toBe(true);
    expect(hasField(added, "url")).toBe(false);
    expect(fieldOf(added, "type")).toBe("book");
    expect(fieldOf(added, "url")).toBeNull();
  });

  it("go into an empty block, and a note with no block is left as it is", () => {
    expect(withFrontLines("---\n---\nbody\n", ["a: 1"])).toBe("---\na: 1\n---\nbody\n");
    expect(withFrontLines("body\n", ["a: 1"])).toBe("body\n");
  });

  it("do not read a line from the body of the note", () => {
    expect(hasField("---\na: 1\n---\nauthor: nobody\n", "author")).toBe(false);
  });
});

describe("what is read from a transcript note", () => {
  it("is the show notes above the transcript, and the episode's own page apart", () => {
    const notes = showNotesOf(note);
    expect(notes).toContain("## Description");
    expect(notes).toContain("amazon.com/Atomic-Habits");
    expect(notes).not.toContain("First paragraph");
    expect(notes).not.toContain("source:");
    expect(ownLink(note)).toBe("https://shows.example.org/habits");
    expect(ownLink("---\na: 1\n---\n")).toBeNull();
  });

  it("is the spoken words without their times and without the lines for a cut ad", () => {
    const text = transcriptNote({ title: "t", spoken: ["One.", "[ad removed]", "Two."] }).replace("[0:40] [ad removed]", "[ad removed]");
    expect(spokenOf(text)).toBe("One.\n\nTwo.");
  });

  it("is the whole body for a note with no transcript heading", () => {
    expect(spokenOf("---\na: 1\n---\nJust some words.\n")).toBe("Just some words.");
    expect(showNotesOf("---\na: 1\n---\nJust some words.\n")).toBe("Just some words.\n");
  });
});
