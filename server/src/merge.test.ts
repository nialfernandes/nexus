// The three-way line merge on its own: which edits it keeps together and which it calls a clash. The saves that
// meet it through the Worker are in saves.test.ts; this holds the shapes of edit those do not reach.

import { describe, expect, it } from "vitest";
import { mergeText, splitLines } from "./merge";

describe("splitLines", () => {
  it("keeps each line's ending, and a last line that has none", () => {
    expect(splitLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitLines("a\r\nb")).toEqual(["a\r\n", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
  });
});

describe("edits that are both kept", () => {
  it("keeps an edit at the top and another at the bottom", () => {
    expect(mergeText("one\ntwo\nthree\n", "ONE\ntwo\nthree\n", "one\ntwo\nTHREE\n")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("keeps edits to neighbouring lines, which share no line", () => {
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n")).toBe("A\nB\nc\n");
  });

  it("keeps a line added at the end beside an edit at the top", () => {
    expect(mergeText("one\ntwo\n", "ONE\ntwo\n", "one\ntwo\nthree\n")).toBe("ONE\ntwo\nthree\n");
  });

  it("keeps a line added just before a line the other side edited, and just after one", () => {
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nnew\nb\nc\n")).toBe("a\nnew\nB\nc\n");
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nb\nnew\nc\n")).toBe("a\nB\nnew\nc\n");
  });

  it("keeps a deletion beside an edit elsewhere", () => {
    expect(mergeText("a\nb\nc\nd\n", "b\nc\nd\n", "a\nb\nc\nD\n")).toBe("b\nc\nD\n");
  });

  it("takes the same change made on both sides once", () => {
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")).toBe("a\nB\nc\n");
    expect(mergeText("a\nb\nc\n", "a\nc\n", "a\nc\n")).toBe("a\nc\n");
  });

  it("keeps Windows line ends as they were written", () => {
    expect(mergeText("a\r\nb\r\nc\r\n", "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n")).toBe("A\r\nb\r\nC\r\n");
  });

  it("merges from an empty base when only one side wrote anything", () => {
    expect(mergeText("", "", "new\n")).toBe("new\n");
  });
});

describe("edits that are a clash", () => {
  it("is two different edits to the same line", () => {
    expect(mergeText("one\ntwo\nthree\n", "one\nTWO\nthree\n", "one\nDEUX\nthree\n")).toBeNull();
  });

  it("is an edit to a line the other side deleted", () => {
    expect(mergeText("a\nb\nc\n", "a\nc\n", "a\nB\nc\n")).toBeNull();
  });

  it("is a line added inside a stretch the other side rewrote", () => {
    expect(mergeText("a\nb\nc\nd\n", "a\nX\nY\nd\n", "a\nb\nnew\nc\nd\n")).toBeNull();
  });

  it("is two different lines added at the same place", () => {
    expect(mergeText("a\nb\n", "a\nours\nb\n", "a\ntheirs\nb\n")).toBeNull();
  });

  it("is the end of a line that gained or lost its final newline on one side", () => {
    expect(mergeText("a\nb\n", "a\nb", "a\nB\n")).toBeNull();
  });

  it("is a change too big to follow, rather than a guess", () => {
    const base = Array.from({ length: 3000 }, (_, n) => `line ${n}\n`).join("");
    const ours = Array.from({ length: 3000 }, (_, n) => `ours ${n}\n`).join("");
    const theirs = Array.from({ length: 3000 }, (_, n) => `theirs ${n}\n`).join("");
    expect(mergeText(base, ours, theirs)).toBeNull();
  });
});
