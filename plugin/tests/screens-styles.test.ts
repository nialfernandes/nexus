// The stylesheet the screens are drawn with, held to what it says it is: every colour is a token written once at its top, every class the
// screens use has a rule, and the sizes of the drawn parts are the drawn ones. And the rule for what a device sends: nothing in the
// screens' code can turn text into markup.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN = process.cwd();
const STYLES = readFileSync(path.join(PLUGIN, "styles.css"), "utf8");
const SCREENS = path.join(PLUGIN, "src", "screens");
const sources = readdirSync(SCREENS).filter((file) => file.endsWith(".ts")).map((file) => [file, readFileSync(path.join(SCREENS, file), "utf8")] as const);

/** The stylesheet without its comments. */
const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
/** The rule that holds the tokens: the one whose selector is `.nexus-screen` alone. */
const TOKENS = /(^|\n)\.nexus-screen \{([^}]*)\}/.exec(CSS)?.[2] ?? "";
const tokens = (): Record<string, string> => Object.fromEntries([...TOKENS.matchAll(/(--nx-[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));

describe("the tokens", () => {
  it("are written once, in one rule at the top of the file, and are the drawn colours, radii and type", () => {
    expect(tokens()).toMatchObject({
      "--nx-teal": "#2FCDB8",
      "--nx-ink": "#0F1013",
      "--nx-ink-soft": "#3A3A40",
      "--nx-ground": "#EEEDEA",
      "--nx-sand": "#F2F1EE",
      "--nx-cream": "#FFF3D6",
      "--nx-red-line": "#D1293D",
      "--nx-red-fill": "#FDECEE",
      "--nx-radius-card": "16px",
      "--nx-radius-slab": "22px",
      "--nx-radius-pill": "999px",
    });
    expect(tokens()["--nx-font-display"]).toMatch(/^"Unbounded"/);
    expect(tokens()["--nx-font-body"]).toMatch(/^"Instrument Sans"/);
    expect(tokens()["--nx-font-mono"]).toMatch(/^"JetBrains Mono"/);
  });

  it("are the only place a colour is written: no hex, rgb or named colour in any other rule", () => {
    const outside = CSS.replace(TOKENS, "");
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []).toEqual([]);
    expect(outside.match(/:\s*(white|black|red|blue|green|yellow|orange|gray|grey)\b/gi) ?? []).toEqual([]);
  });

  it("is light only: no dark scheme and no media query for one", () => {
    expect(CSS).not.toMatch(/prefers-color-scheme|\.theme-dark/);
  });

  it("never uses an animation: the waiting dot does not pulse", () => {
    expect(CSS).not.toMatch(/animation|@keyframes|transition/);
  });
});

describe("the drawn sizes", () => {
  const rule = (selector: string): string => {
    const found = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()*+?^$|\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(CSS);
    if (!found) throw new Error(`no rule for ${selector}`);
    return found[1]!;
  };

  it("have a slab with 22 px corners and 10 px above and below its one 32 px line, a 16 px card with 14 px of padding and 12 px between things, and 30 px pills", () => {
    expect(rule(".nx-slab")).toContain("var(--nx-radius-slab)");
    expect(rule(".nx-slab")).toMatch(/padding: 10px 16px/);
    expect(rule(".nx-slab__bar")).toMatch(/height: 32px/);
    expect(rule(".nx-card")).toMatch(/padding: 14px/);
    expect(rule(".nx-card")).toMatch(/gap: 12px/);
    expect(rule(".nx-card")).toContain("var(--nx-radius-card)");
    expect(rule(".nexus-screen .nx-pill")).toMatch(/height: 30px/);
    expect(rule(".nx-slab__mark")).toMatch(/font-size: 22px/);
    expect(rule(".nx-slab__mark")).toMatch(/font-weight: 900/);
    expect(rule(".nx-slab__divider")).toMatch(/width: 1px/);
    expect(rule(".nx-slab__divider")).toMatch(/height: 16px/);
    expect(rule(".nx-slab__title")).toMatch(/font-size: 15px/);
    expect(rule(".nx-slab__title")).toMatch(/font-weight: 700/);
  });

  it("have the line under the title in the body, 13 px at 85 percent, with 16 px under it", () => {
    expect(rule(".nx-slab__line")).toMatch(/font-size: 13px/);
    expect(rule(".nx-slab__line")).toMatch(/opacity: 0\.85/);
    expect(rule(".nx-slab__line")).toMatch(/padding: 0 0 16px/);
  });

  it("have code boxes 44 px high with 4 px inside a group and 12 px between groups, the key's boxes 38 px, the typed-back boxes 44 px square", () => {
    expect(rule(".nx-box")).toMatch(/height: 44px/);
    expect(rule(".nx-code__group")).toMatch(/gap: 4px/);
    expect(rule(".nx-code")).toMatch(/gap: 12px/);
    expect(rule(".nx-keyrow .nx-box")).toMatch(/height: 38px/);
    expect(rule(".nx-group .nx-box")).toMatch(/flex: 0 0 44px/);
  });

  it("have a 38 by 22 px switch, an 18 px tick box and knob, a 36 px circle and an 8 px dot", () => {
    expect(rule(".nexus-screen .nx-switch")).toMatch(/width: 38px/);
    expect(rule(".nexus-screen .nx-switch")).toMatch(/height: 22px/);
    expect(rule(".nx-switch__knob")).toMatch(/width: 18px/);
    expect(rule(".nexus-screen .nx-tick")).toMatch(/width: 18px/);
    expect(rule(".nx-circle")).toMatch(/width: 36px/);
    expect(rule(".nx-status__dot")).toMatch(/width: 8px/);
  });

  it("is dim, at 40 percent, where a button ignores taps", () => {
    expect(rule('.nexus-screen .nx-pill[aria-disabled="true"]')).toMatch(/opacity: 0\.4/);
  });
});

describe("the classes the screens use", () => {
  /** Every class name the screens' code writes down, whole or as the start of one that is finished with a variable. */
  const used = (): string[] => {
    const found = new Set<string>();
    for (const [, code] of sources) for (const match of code.matchAll(/\bnx-[a-z0-9_-]+/g)) found.add(match[0]);
    return [...found];
  };

  it("each have a rule in the stylesheet (a class finished with a variable has a rule for each way it ends)", () => {
    const defined = new Set([...CSS.matchAll(/\.(nx-[a-z0-9_-]+)/g)].map((match) => match[1]!));
    const missing = used().filter((name) => !defined.has(name) && ![...defined].some((rule) => rule.startsWith(name) && name.endsWith("-")));
    expect(missing).toEqual([]);
    expect(used().length).toBeGreaterThan(30);
  });

  it("and every way a computed class name ends is styled", () => {
    for (const name of ["nx-code__group--4", "nx-code__group--2", "nx-pill--main", "nx-pill--quiet", "nx-circle--done", "nx-circle--fault", "nx-circle--neutral"]) {
      expect(CSS, name).toContain(`.${name}`);
    }
  });
});

describe("what a device sent is only ever text", () => {
  it("the screens' code and the modal never turn text into markup", () => {
    const modal = readFileSync(path.join(PLUGIN, "src", "screens", "modal.ts"), "utf8");
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const [file, code] of [...sources, ["modal.ts", modal] as const]) {
      expect(code, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|dangerouslySet/);
    }
  });
});
