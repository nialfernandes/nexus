// The short hash kept with every version is FNV-1a over the text's UTF-8 bytes. These are the published test
// values for the 64-bit form, so a change to the arithmetic is caught here and not in a version's hash years on.

import { describe, expect, it } from "vitest";
import { shortHash } from "./hash";

describe("shortHash", () => {
  it("matches the published FNV-1a 64-bit values", () => {
    expect(shortHash("")).toBe("cbf29ce484222325");
    expect(shortHash("a")).toBe("af63dc4c8601ec8c");
    expect(shortHash("foobar")).toBe("85944171f73967e8");
  });

  it("is 16 hex characters for any text, accents and emoji included", () => {
    for (const text of ["", "x", "Café 日本語 🎙️\n", "a line\n".repeat(5000)]) expect(shortHash(text)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("tells one text from another, down to a single character or a line ending", () => {
    expect(shortHash("one\n")).not.toBe(shortHash("one"));
    expect(shortHash("one\r\n")).not.toBe(shortHash("one\n"));
    // The same letter as one character and as a letter plus an accent: two texts, so two hashes.
    expect(shortHash("\u00e9")).not.toBe(shortHash("e\u0301"));
  });
});
