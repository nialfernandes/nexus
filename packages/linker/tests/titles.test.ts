import { describe, expect, it } from "vitest";
import { mentionName, mentionPath, noteName, titleFromSlug, titleKey } from "../src/titles";

describe("titleKey: when two titles are one thing", () => {
  it("ignores case, punctuation and a leading The", () => {
    expect(titleKey("the atomic habits")).toBe(titleKey("Atomic Habits."));
    expect(titleKey("The Power of Now")).toBe(titleKey("power of now"));
    expect(titleKey("Atomic Habits: An Easy & Proven Way")).toBe(titleKey("atomic habits - an easy and proven way"));
  });

  it("ignores apostrophes, accents and the kind of space", () => {
    expect(titleKey("Don’t Make Me Think")).toBe(titleKey("dont make me think"));
    expect(titleKey("Café Society")).toBe(titleKey("cafe  society"));
  });

  it("keeps a title that is only the word The, and does not cut The from the front of a longer word", () => {
    expect(titleKey("The")).toBe("the");
    expect(titleKey("Theodore Roosevelt")).toBe("theodore roosevelt");
  });

  it("is empty for a title with nothing in it to compare", () => {
    expect(titleKey("!?…")).toBe("");
    expect(titleKey("   ")).toBe("");
  });

  it("keeps different titles apart", () => {
    expect(titleKey("Atomic Habits")).not.toBe(titleKey("Atomic Habits Journal"));
    expect(titleKey("Deep Work")).not.toBe(titleKey("Deep Learning"));
  });
});

describe("noteName: a title as the name of a note", () => {
  it("takes out what a link, a path or a tag reads as syntax", () => {
    expect(noteName("Atomic Habits.")).toBe("Atomic Habits");
    expect(noteName('What is "this"? [a] #b')).toBe("What is this a b");
    expect(noteName("a/b\\c:d")).toBe("abcd");
    expect(noteName("  two   words\n and a line break ")).toBe("two words and a line break");
  });

  it("is empty when nothing is left, and never starts with a dot", () => {
    expect(noteName("...")).toBe("");
    expect(noteName("/\\?")).toBe("");
    expect(noteName(".hidden")).toBe("hidden");
  });

  it("cuts a long title at a word", () => {
    const long = Array.from({ length: 40 }, (_, at) => `word${at}`).join(" ");
    const name = noteName(long);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(long.startsWith(name)).toBe(true);
    expect(long.charAt(name.length)).toBe(" ");
  });
});

describe("the path of a note in Mentions/", () => {
  it("is the folder and the name, and the name is read back from it", () => {
    expect(mentionPath("Atomic Habits")).toBe("Mentions/Atomic Habits.md");
    expect(mentionName("Mentions/Atomic Habits.md")).toBe("Atomic Habits");
  });

  it("has no name for a path that is not a note straight in the folder", () => {
    expect(mentionName("Mentions/Books/Atomic Habits.md")).toBeNull();
    expect(mentionName("Hush/Atomic Habits.md")).toBeNull();
    expect(mentionName("Mentions/Atomic Habits.txt")).toBeNull();
    expect(mentionName("Mentions/.md")).toBeNull();
  });
});

describe("titleFromSlug: the words of a web address as a title", () => {
  it("gives a lower case slug capitals, keeping small words small", () => {
    expect(titleFromSlug("atomic-habits")).toBe("Atomic Habits");
    expect(titleFromSlug("the_power_of_now")).toBe("The Power of Now");
  });

  it("keeps the capitals a slug already has", () => {
    expect(titleFromSlug("Atomic-Habits-An-Easy-Proven-Way")).toBe("Atomic Habits An Easy Proven Way");
    expect(titleFromSlug("Fahrenheit_451")).toBe("Fahrenheit 451");
  });

  it("reads percent-encoding", () => {
    expect(titleFromSlug("caf%C3%A9-society")).toBe("Café Society");
    // A slug that is not valid percent-encoding is read as it is.
    expect(titleFromSlug("bad%zz-title")).toBe("Bad%zz Title");
  });
});
