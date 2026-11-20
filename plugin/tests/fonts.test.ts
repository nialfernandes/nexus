// The screens wear their own typefaces. Obsidian does not have Unbounded, Instrument Sans or JetBrains Mono, so styles.css carries a
// cut-down copy of each (the weights and the Latin letters the screens use) as an @font-face with the font written in as base64, and
// the licence text of each beside them, because the licence (the SIL Open Font License 1.1) asks for its copyright line and its text
// to travel with the font and a plugin is three files. The fonts come from server/public/nexus/fonts and plugin/tools/embed-fonts.py
// writes the block; this holds the file to what the script says it wrote.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN = process.cwd();
const FONTS = path.join(PLUGIN, "..", "server", "public", "nexus", "fonts");
const STYLES = readFileSync(path.join(PLUGIN, "styles.css"), "utf8");

/** What the three typefaces are called in the screens' tokens, the licence text kept for each, and the copyright line that text starts with. */
const FAMILIES = [
  { name: "Unbounded", token: "--nx-font-display", licence: "unbounded-OFL.txt", copyright: "Copyright 2022 The Unbounded Project Authors (https://github.com/googlefonts/unbounded)" },
  { name: "Instrument Sans", token: "--nx-font-body", licence: "instrument-sans-OFL.txt", copyright: "Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)" },
  { name: "JetBrains Mono", token: "--nx-font-mono", licence: "jetbrains-mono-OFL.txt", copyright: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)" },
] as const;

/** The size the stylesheet may grow to. It was 15 KB before the fonts; the three cut-down fonts, written as base64, and their three licence texts made it 86 KB. */
const MOST_BYTES = 100_000;

interface Face {
  family: string;
  weights: [number, number];
  data: string;
}

/** Every @font-face in the file, with the font it holds as bytes. */
const faces = (): Face[] =>
  [...STYLES.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const body = match[1]!;
    const weights = /font-weight:\s*(\d+)\s+(\d+)\s*;/.exec(body);
    return {
      family: /font-family:\s*"([^"]+)"/.exec(body)?.[1] ?? "",
      weights: [Number(weights?.[1]), Number(weights?.[2])],
      data: /src:\s*url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)\s*format\("woff2"\)/.exec(body)?.[1] ?? "",
    };
  });

/** The stylesheet without its comments or its fonts. */
const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\s*\{[^}]*\}/g, "");

describe("the typefaces in styles.css", () => {
  it("are three @font-face rules, one for each typeface the screens name, each a woff2 font written in as base64 and nothing fetched", () => {
    expect(faces().map((face) => face.family).sort()).toEqual(["Instrument Sans", "JetBrains Mono", "Unbounded"]);
    for (const family of FAMILIES) {
      const face = faces().find((candidate) => candidate.family === family.name)!;
      const bytes = Buffer.from(face.data, "base64");
      expect(bytes.subarray(0, 4).toString("latin1"), `${family.name} is a woff2 file`).toBe("wOF2");
      expect(bytes.readUInt32BE(8), `${family.name}: the length its header gives is the length it has, so it was not cut short`).toBe(bytes.length);
      expect(bytes.length, `${family.name} is small: it is cut down to what the screens use`).toBeLessThan(25_000);
    }
    expect(STYLES.match(/url\(([^)]{0,40})/g)!.every((use) => use.startsWith("url(data:font/woff2;base64,")), "no font is fetched from anywhere").toBe(true);
    expect(STYLES.match(/@import|https?:\/\/[^\s)"']+\.(woff2?|ttf|otf)/g) ?? []).toEqual([]);
  });

  it("are the ones the screens name: each token's first family has a rule, and every weight a rule asks for is in the range its font was cut to", () => {
    const tokens = Object.fromEntries([...STYLES.matchAll(/(--nx-font-[a-z]+):\s*"([^"]+)"/g)].map((match) => [match[1]!, match[2]!]));
    for (const family of FAMILIES) {
      expect(tokens[family.token], `${family.token} names the typeface first`).toBe(family.name);
      expect(faces().some((face) => face.family === family.name), `${family.name} has an @font-face`).toBe(true);
    }
    const range = (token: string): [number, number] => faces().find((face) => face.family === tokens[token])!.weights;
    // A rule that names a typeface can only use the weights that typeface was cut to; a rule that names none inherits the body's.
    for (const rule of CSS.matchAll(/\{([^{}]*)\}/g)) {
      const weight = /font-weight:\s*(\d+)/.exec(rule[1]!);
      if (!weight) continue;
      const token = /font-family:\s*var\((--nx-font-[a-z]+)\)/.exec(rule[1]!)?.[1] ?? "--nx-font-body";
      const [low, high] = range(token);
      expect(Number(weight[1]), `weight ${weight[1]} in a rule with ${token}`).toBeGreaterThanOrEqual(low);
      expect(Number(weight[1])).toBeLessThanOrEqual(high);
    }
  });

  it("carry the licence text of each, unchanged, and its copyright line, inside styles.css: the file that ships with the plugin", () => {
    for (const family of FAMILIES) {
      const text = readFileSync(path.join(FONTS, family.licence), "utf8").trimEnd();
      expect(text.split("\n")[0], `${family.licence} starts with the copyright line`).toBe(family.copyright);
      // The text is written inside a comment, each line behind " * ": taking that off gives the text again.
      const written = STYLES.split("\n").filter((line) => line.startsWith(" *")).map((line) => line.replace(/^ \* ?/, "")).join("\n");
      expect(written, `${family.name}: the whole licence text is in styles.css`).toContain(text);
      expect(STYLES, `${family.name}: and its copyright line`).toContain(family.copyright);
    }
    expect(STYLES).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("add little: the stylesheet stays under the size the three fonts and their licences came to", () => {
    expect(Buffer.byteLength(STYLES, "utf8")).toBeLessThan(MOST_BYTES);
  });
});
