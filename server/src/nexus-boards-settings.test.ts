// The settings of the Nexus page's picture checks (e2e/nexus-board-settings.ts, used by e2e/nexus-boards.spec.ts): how much of a page may differ
// from its board, and the flags the browser is started with. The allowed difference is what keeps a misplaced row or colour from passing, so it
// stays where it was set (0.012) when a check fails on a machine whose letters are drawn another way (nialfernandes #822): the fix is in how the
// browser draws letters, not in how much difference is let through. The spec has to take both from that file, not carry a number of its own.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AT_MOST_DIFFERENT, BOARD_BROWSER_ARGS } from "../e2e/nexus-board-settings.ts";

const SPEC = readFileSync(join(import.meta.dirname, "../e2e/nexus-boards.spec.ts"), "utf8");

describe("the picture checks of the Nexus page", () => {
  it("let through 1.2 percent of a page differing from its board, as they did when the boards were first held against the page", () => {
    expect(AT_MOST_DIFFERENT).toBe(0.012);
  });

  it("are held to that by the spec, which has no number of its own", () => {
    expect(SPEC).toMatch(/import \{[^}]*\bAT_MOST_DIFFERENT\b[^}]*\} from "\.\/nexus-board-settings"/);
    expect(SPEC).toMatch(/toBeLessThanOrEqual\(AT_MOST_DIFFERENT\)/);
    expect(SPEC, "no second limit").not.toMatch(/(?:const|let|var)\s+\w*(?:DIFFER|LIMIT|AT_MOST)\w*\s*=/i);
  });

  it("start the browser at twice the size and draw grey, unhinted letters, whatever the machine's font settings ask for", () => {
    expect(BOARD_BROWSER_ARGS).toEqual(["--force-device-scale-factor=2", "--disable-lcd-text", "--font-render-hinting=none"]);
    expect(SPEC).toMatch(/launchOptions: \{ args: BOARD_BROWSER_ARGS \}/);
  });
});
