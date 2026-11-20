#!/usr/bin/env python3
"""
Writes the plugin's three typefaces into plugin/styles.css as base64 @font-face rules, with their licence texts beside them.

    python3 plugin/tools/embed-fonts.py

Needs fontTools and brotli (pip install fonttools brotli). The fonts are the files the approval page already serves, in
server/public/nexus/fonts, with the licence texts kept beside them. Each is a variable font. For the plugin it is cut down:

  - to the weights the screens use (Unbounded 700 to 900, Instrument Sans 400 to 700, JetBrains Mono 500 to 600), so the rest of
    each weight axis goes;
  - to Basic Latin, the no-break space, the typographic quotes and dashes, the ellipsis and the bullet (every word on the
    screens is plain ASCII);
  - to the one layout feature the screens use, kerning;
  - the name records that carry each font's copyright and licence stay in each file.

The Open Font License lets a font be cut down, embedded and passed on with a program as long as its copyright line and the
licence text go with it, so each licence text is written into styles.css just after the rules, unchanged. The three font files
and the three texts are all the plugin has to carry: a plugin is three files (main.js, manifest.json, styles.css), so the
fonts and the licences go inside styles.css.

It rewrites the text between the two marker lines in styles.css, and nothing else in the file.
"""
import base64
import io
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parents[2]
FONTS = ROOT / "server" / "public" / "nexus" / "fonts"
STYLES = ROOT / "plugin" / "styles.css"

BEGIN = "/* BEGIN FONTS: written by plugin/tools/embed-fonts.py, do not edit by hand */"
END = "/* END FONTS */"

# family name, font file, licence text, the weights the screens use (low, high)
FAMILIES = [
    ("Unbounded", "unbounded-var.woff2", "unbounded-OFL.txt", (700, 900)),
    ("Instrument Sans", "instrument-sans-var.woff2", "instrument-sans-OFL.txt", (400, 700)),
    ("JetBrains Mono", "jetbrains-mono-var.woff2", "jetbrains-mono-OFL.txt", (500, 600)),
]

# Basic Latin, the no-break space, the typographic quotes, the dashes, the bullet and the ellipsis.
UNICODES = list(range(0x20, 0x7F)) + [0xA0, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026]


def cut(path: pathlib.Path, weights: tuple[int, int]) -> bytes:
    font = TTFont(path)
    axes = {axis.axisTag: (axis.minValue, axis.defaultValue, axis.maxValue) for axis in font["fvar"].axes}
    limits: dict = {"wght": (max(weights[0], axes["wght"][0]), min(weights[1], axes["wght"][2]))}
    for tag, (_low, default, _high) in axes.items():
        if tag != "wght":
            limits[tag] = default  # any other axis is pinned where the font starts
    font = instancer.instantiateVariableFont(font, limits)
    # Written out and read back, so the subsetter sees the font as a file (a lazy table the instancer leaves made it fail on JetBrains Mono).
    middle = io.BytesIO()
    font.flavor = None
    font.save(middle)
    middle.seek(0)
    font = TTFont(middle)
    options = subset.Options()
    options.layout_features = ["kern"]
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    options.legacy_kern = False
    cutter = subset.Subsetter(options)
    cutter.populate(unicodes=UNICODES)
    cutter.subset(font)
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def block() -> str:
    faces = []
    licences = []
    for family, file, licence, (low, high) in FAMILIES:
        data = base64.b64encode(cut(FONTS / file, (low, high))).decode("ascii")
        faces.append(
            f'@font-face {{\n  font-family: "{family}";\n  font-style: normal;\n  font-weight: {low} {high};\n  font-display: swap;\n'
            f'  src: url(data:font/woff2;base64,{data}) format("woff2");\n}}\n'
        )
        text = (FONTS / licence).read_text(encoding="utf-8").rstrip("\n")
        if "*/" in text or "/*" in text:
            sys.exit(f"{licence} holds a comment mark and cannot be written inside a comment")
        licences.append(f" * ── {family} ──\n" + "\n".join((" * " + line) if line else " *" for line in text.split("\n")))
    head = (
        "/* ── the typefaces ──────────────────────────────────────────────────────────────── */\n"
        "/* Unbounded, Instrument Sans and JetBrains Mono, cut down to the weights and the Latin letters the screens use and written\n"
        " * in below, so the screens look the same in Obsidian as on the approval page and the boards. Each is under the SIL Open Font\n"
        " * License 1.1; its copyright line and the licence text follow the rules, as the licence asks. */\n"
    )
    tail = "/* The licence of each typeface, unchanged from its project's OFL.txt (kept beside the fonts in server/public/nexus/fonts).\n *\n" + "\n *\n".join(licences) + "\n */\n"
    return "\n".join([BEGIN, head + "\n".join(faces), tail + END])


def main() -> None:
    css = STYLES.read_text(encoding="utf-8")
    start, finish = css.index(BEGIN), css.index(END) + len(END)
    STYLES.write_text(css[:start] + block() + css[finish:], encoding="utf-8")


if __name__ == "__main__":
    main()
