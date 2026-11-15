// The agent checks a path with the plugin's own rule. The two are held to the same answers over a list of paths, the plugin's
// function imported here and not copied, so a change to either shows up as a failing test.

import { describe, expect, it } from "vitest";
import { duplicateNoteName, isClashCopy, isNote, isSafeNotePath as pluginIsSafeNotePath } from "../../../plugin/src/notes";
import { duplicateNotePath, isClashCopy as agentIsClashCopy, isNote as agentIsNote, isSafeNotePath } from "../src/paths";

const PATHS = [
  "Agent/2026-11-15 First.md", "a.md", "Ideas/a b/c.MD", "Ideas/one.md", "日本語/メモ.md", "Daily/2026-11-15.md",
  "", " ", "/a.md", "a.md/", "a//b.md", "./a.md", "../a.md", "a/../b.md", "a/./b.md", "a\\b.md", "a\u0000b.md", "a\nb.md", "a\u001fb.md",
  ".hidden.md", ".obsidian/plugins/x.md", "Notes/.trash/x.md", "Notes/.x.md", "a.txt", "a.md.txt", "a", "image.png", "folder/",
  "Ideas/a (clash My iPhone 2026-11-14).md", "Ideas/a (clash My iPhone 2026-11-14 2).md", "Ideas/a (duplicate My iPhone 2026-11-14).md",
  "Ideas/a (duplicate agent 2026-11-15 2).md", "a (clash x 2026-11-14).MD", "a.md ", " a.md",
];

describe("the agent's path rule", () => {
  for (const path of PATHS) {
    it(`gives the plugin's answer for ${JSON.stringify(path)}`, () => {
      expect(isSafeNotePath(path)).toBe(pluginIsSafeNotePath(path));
      expect(agentIsNote(path)).toBe(isNote(path));
      expect(agentIsClashCopy(path)).toBe(isClashCopy(path));
    });
  }

  it("refuses something that is not text", () => {
    expect(isSafeNotePath(undefined as unknown as string)).toBe(false);
    expect(isSafeNotePath(7 as unknown as string)).toBe(false);
  });

  it("names a duplicate as the plugin does, and a path the plugin takes", () => {
    const when = new Date(2026, 10, 15, 12);
    for (const [path, name] of [["Ideas/a.md", "agent"], ["a.md", "agent"], ["Daily/x y.md", "my/agent"]] as const) {
      const mine = duplicateNotePath(path, name, when, () => false);
      expect(mine).toBe(duplicateNoteName(path, name, when, () => false));
      expect(pluginIsSafeNotePath(mine), `${mine} is a note the plugin takes`).toBe(true);
    }
    expect(duplicateNotePath("a.md", "", when, () => false), "a name left blank is the agent").toBe("a (duplicate agent 2026-11-15).md");
    const taken = new Set(["a (duplicate agent 2026-11-15).md"]);
    expect(duplicateNotePath("a.md", "agent", when, (path) => taken.has(path))).toBe("a (duplicate agent 2026-11-15 2).md");
    expect(duplicateNotePath("a.md", "agent", when, (path) => taken.has(path))).toBe(duplicateNoteName("a.md", "agent", when, (path) => taken.has(path)));
  });
});
