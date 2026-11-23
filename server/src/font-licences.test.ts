// The typefaces of the approval page and the Nexus page, and their licences. Each typeface is under the SIL Open Font License 1.1, which says the
// font's own copyright notice and the licence text travel with the font files. So every font file in
// public/nexus/fonts has to have, beside it, a licence text whose copyright line names its family and which holds the
// whole licence, and LICENSES.md has to say what is there. The files are read from the folder as they sit in the
// repository (not through the Worker, which serves only the three typefaces and not these).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FONTS = join(import.meta.dirname, "../public/nexus/fonts");

const files = readdirSync(FONTS);
const fontFiles = files.filter((name) => name.endsWith(".woff2"));
const licenceFiles = files.filter((name) => /OFL.*\.txt$/i.test(name));

/** Letters and digits only, in lower case, so "instrument-sans-var" and "The Instrument Sans Project" compare. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The family a font file is for, from its file name: `instrument-sans-var.woff2` is "instrumentsans". */
const familyOf = (fontFile: string): string => squash(fontFile.replace(/\.woff2$/, "").replace(/-var$/, ""));

/** A licence text's own copyright line (the notice the OFL says must travel with the font). */
const copyrightLine = (text: string): string => text.match(/^Copyright .*$/m)?.[0] ?? "";

/** The licence text beside a font file: the one whose copyright line names the font's family. */
const licenceOf = (fontFile: string): { name: string; text: string } | undefined => {
  for (const name of licenceFiles) {
    const text = readFileSync(join(FONTS, name), "utf8");
    if (squash(copyrightLine(text)).includes(familyOf(fontFile))) return { name, text };
  }
  return undefined;
};

describe("the pages' typefaces", () => {
  it("are found in the folder, so the checks below are not run over nothing", () => {
    expect(fontFiles.length).toBeGreaterThan(0);
  });

  it("each have a licence text beside them that names their family", () => {
    for (const font of fontFiles) {
      expect(licenceOf(font), `${font} has no licence text beside it whose copyright line names its family`).toBeDefined();
    }
  });

  it("each have the whole SIL Open Font License 1.1, from the start of its text to its last line", () => {
    for (const font of fontFiles) {
      const { text = "" } = licenceOf(font) ?? {};
      expect(text, `${font}: the licence's title`).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
      for (const part of ["PREAMBLE", "DEFINITIONS", "PERMISSION & CONDITIONS", "TERMINATION", "DISCLAIMER"]) {
        expect(text, `${font}: the licence's ${part}`).toMatch(new RegExp(`^${part}$`, "m"));
      }
      expect(text.trimEnd().endsWith("OTHER DEALINGS IN THE FONT SOFTWARE."), `${font}: the licence's last line`).toBe(true);
    }
  });

  it("each have a licence text of their own, not one shared with another family", () => {
    const names = fontFiles.map((font) => licenceOf(font)?.name);
    expect(new Set(names).size).toBe(fontFiles.length);
  });

  it("are all described in LICENSES.md, with the licence text it says sits beside each", () => {
    const notes = readFileSync(join(FONTS, "LICENSES.md"), "utf8");
    for (const font of fontFiles) {
      expect(notes, `${font} is named in LICENSES.md`).toContain(`\`${font}\``);
      const licence = licenceOf(font)?.name;
      expect(licence, `${font} has a licence text`).toBeDefined();
      expect(notes, `${licence} is named in LICENSES.md`).toContain(`\`${licence}\``);
    }
    expect(notes, "LICENSES.md no longer says the texts are still to be added").not.toMatch(/still to be/i);
  });
});
