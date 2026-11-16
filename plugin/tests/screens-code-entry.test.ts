// What a code field is, with no screen: boxes that take one character each (or four, for a Recovery Key's groups), typed into one at a
// time or pasted into all at once. Capitals and small letters both count, spaces and hyphens are ignored, and an entry that is whole
// says so as the last character goes in: that is the whole of "no Verify button".

import { describe, expect, it } from "vitest";
import { CodeEntry, codeCharacters } from "../src/screens/code-entry";

describe("what a code takes", () => {
  it("takes letters and digits as capitals, and drops spaces, hyphens and anything else", () => {
    expect(codeCharacters("ab12-cd 34\n+e/f")).toBe("AB12CD34EF");
    expect(codeCharacters("")).toBe("");
    expect(codeCharacters(" - ")).toBe("");
  });
});

describe("a code of single boxes", () => {
  const ten = () => new CodeEntry(Array(10).fill(1));

  it("takes a character into its box and sends the caret to the next, and is whole only when the tenth is in", () => {
    const entry = ten();
    for (let index = 0; index < 9; index++) {
      const edit = entry.type(index, "abcdefghij"[index]!);
      expect(edit).toEqual({ focus: index + 1, complete: false });
    }
    expect(entry.complete).toBe(false);
    expect(entry.type(9, "j")).toEqual({ focus: 9, complete: true });
    expect(entry.text).toBe("ABCDEFGHIJ");
    expect(entry.at(0)).toBe("A");
  });

  it("keeps the newest character when a full box is typed over, and takes only a letter or a digit", () => {
    const entry = ten();
    entry.type(0, "A");
    expect(entry.type(0, "AB")).toEqual({ focus: 1, complete: false });
    expect(entry.at(0)).toBe("B");
    entry.type(1, "-");
    expect(entry.at(1), "a hyphen is not a character of the code").toBe("");
  });

  it("fills every box from the first when the whole code is pasted into any box, however it was written", () => {
    const entry = ten();
    expect(entry.paste(6, "ab12 cd34-ef")).toEqual({ focus: 9, complete: true });
    expect(entry.text).toBe("AB12CD34EF");
    expect(entry.paste(3, "  zz99yy88xw")).toEqual({ focus: 9, complete: true });
    expect(entry.text, "pasting again replaces it").toBe("ZZ99YY88XW");
  });

  it("fills from the box it was pasted into when only a part of the code was pasted, and is not whole", () => {
    const entry = ten();
    entry.type(0, "A");
    expect(entry.paste(1, "bcd")).toEqual({ focus: 4, complete: false });
    expect(entry.text).toBe("ABCD");
    expect(entry.complete).toBe(false);
  });

  it("takes only as much as there is room for when more than a code is pasted", () => {
    const entry = ten();
    expect(entry.paste(0, "AB12CD34EFGHIJ").complete).toBe(true);
    expect(entry.text).toBe("AB12CD34EF");
  });

  it("clears the box before on Backspace in an empty box, and the caret goes there; in a full box it clears that one", () => {
    const entry = ten();
    entry.paste(0, "AB12");
    expect(entry.backspace(4)).toEqual({ focus: 3, complete: false });
    expect(entry.text).toBe("AB1");
    expect(entry.backspace(2)).toEqual({ focus: 2, complete: false });
    expect(entry.text).toBe("AB");
    expect(entry.backspace(0), "nothing before the first box").toEqual({ focus: 0, complete: false });
  });

  it("is shown red until the first edit, whichever edit it is", () => {
    for (const edit of [(entry: CodeEntry) => entry.type(0, "A"), (entry: CodeEntry) => entry.paste(0, "A"), (entry: CodeEntry) => entry.backspace(1)]) {
      const entry = ten();
      entry.paste(0, "AB12CD34EF");
      entry.wrong = true;
      edit(entry);
      expect(entry.wrong).toBe(false);
    }
  });

  it("can be emptied", () => {
    const entry = ten();
    entry.paste(0, "AB12CD34EF");
    entry.wrong = true;
    entry.clear();
    expect(entry.text).toBe("");
    expect(entry.wrong).toBe(false);
  });
});

describe("a Recovery Key, one box for each group of four", () => {
  const key = () => new CodeEntry(Array(14).fill(4));

  it("takes four characters into a box, then the caret goes to the next; the key is whole when the fourteenth group is full", () => {
    const entry = key();
    expect(entry.type(0, "A")).toEqual({ focus: 0, complete: false });
    expect(entry.type(0, "A1B")).toEqual({ focus: 0, complete: false });
    expect(entry.type(0, "A1B2")).toEqual({ focus: 1, complete: false });
    for (let box = 1; box < 13; box++) entry.type(box, "C3D4");
    expect(entry.complete).toBe(false);
    expect(entry.type(13, "E5F6")).toEqual({ focus: 13, complete: true });
    expect(entry.text).toBe("A1B2" + "C3D4".repeat(12) + "E5F6");
  });

  it("fills every group when the whole key is pasted, written with hyphens or spaces or none, and carries what overflows a box into the next", () => {
    const written = Array.from({ length: 14 }, (_, group) => `A${group.toString(36).toUpperCase()}Z9`);
    for (const pasted of [written.join("-"), written.join(" ").toLowerCase(), written.join("")]) {
      const entry = key();
      expect(entry.paste(5, pasted).complete).toBe(true);
      expect(entry.text).toBe(written.join(""));
    }
    const overflow = key();
    overflow.type(0, "ABCDEFGHIJ");
    expect(overflow.text, "ten characters typed into one box go on into the next two").toBe("ABCDEFGHIJ");
    expect(overflow.at(1)).toBe("EFGH");
  });
});
