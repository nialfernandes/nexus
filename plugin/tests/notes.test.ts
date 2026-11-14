// The small rules the engine rests on: what is a note, how two texts are told apart, and what a clash copy is called.
// These are plain functions, so they are called directly.

import { describe, expect, it } from "vitest";
import { clashCopyName, dayStamp, fingerprint, isClashCopy, isNote, nameOf } from "../src/notes";

describe("isNote", () => {
  it("is a markdown file outside hidden folders", () => {
    expect(isNote("Ideas/a.md")).toBe(true);
    expect(isNote("top.md")).toBe(true);
    expect(isNote("Ideas/Deep/Er/a b c.md")).toBe(true);
    expect(isNote("Ideas/UPPER.MD")).toBe(true);
  });

  it("is not an attachment, a canvas or a file with no extension", () => {
    for (const path of ["Ideas/pic.png", "Ideas/board.canvas", "Ideas/readme", "Ideas/a.md.moved", "a.pdf"]) {
      expect(isNote(path), path).toBe(false);
    }
  });

  it("is not a clash copy: that stays in the vault it was made in", () => {
    for (const path of ["Ideas/a (clash Test iPhone 2026-11-14).md", "top (clash Mac 2026-11-14 2).md", "Ideas/a (clash Mac-Studio- 2 2026-01-05).md"]) {
      expect(isClashCopy(path), path).toBe(true);
      expect(isNote(path), path).toBe(false);
    }
    for (const path of ["Ideas/clash.md", "Ideas/a (clash).md", "Ideas/a (clash of titans).md", "Ideas/a (2026-11-14).md"]) {
      expect(isClashCopy(path), path).toBe(false);
      expect(isNote(path), path).toBe(true);
    }
  });

  it("is not anything inside .obsidian or another hidden folder, nor a hidden file", () => {
    for (const path of [".obsidian/snippets/tidy.md", ".obsidian/plugins/nexus/data.json", ".trash/old.md", "Ideas/.hidden/a.md", ".hidden.md"]) {
      expect(isNote(path), path).toBe(false);
    }
  });
});

describe("fingerprint", () => {
  it("is the same for the same text and differs for texts that differ even by one character or a line ending", () => {
    expect(fingerprint("one\ntwo\n")).toBe(fingerprint("one\ntwo\n"));
    // The last two look alike on a screen: one letter, and a letter with an accent added after it.
    const seen = new Set(["", "a", "b", "one\ntwo\n", "one\ntwo", "one\r\ntwo\r\n", "one two\n", "ONE\ntwo\n", "\u00e9", "e\u0301"].map(fingerprint));
    expect(seen.size).toBe(10);
  });
});

describe("clashCopyName", () => {
  const WHEN = new Date(2026, 10, 14, 12, 0, 0);

  it("sits beside the note, named for the device and the day", () => {
    expect(clashCopyName("Ideas/a.md", "Test iPhone", WHEN, () => false)).toBe("Ideas/a (clash Test iPhone 2026-11-14).md");
    expect(clashCopyName("top.md", "Mac", WHEN, () => false)).toBe("top (clash Mac 2026-11-14).md");
  });

  it("never takes a name that is taken: it counts up instead", () => {
    const taken = new Set(["Ideas/a (clash Mac 2026-11-14).md", "Ideas/a (clash Mac 2026-11-14 2).md"]);
    expect(clashCopyName("Ideas/a.md", "Mac", WHEN, (path) => taken.has(path))).toBe("Ideas/a (clash Mac 2026-11-14 3).md");
  });

  it("is a legal file name even when the device's name is not one", () => {
    const name = nameOf(clashCopyName("Ideas/a.md", 'Mac/Studio: "2" <a|b>? #1 [x] ^y', WHEN, () => false));
    expect(name).not.toMatch(/[\\/:*?"<>|#^[\]]/);
  });

  it("writes the day with two digits for the month and the day", () => {
    expect(dayStamp(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});
