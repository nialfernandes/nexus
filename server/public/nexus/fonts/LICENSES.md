# Fonts the approval page uses

The page loads nothing from outside Nexus, so its three typefaces are served from here (to the owner only, like the
rest of the page: see `src/plugs/cloudflare/page.ts`). Each is a variable font, Latin characters only.

| File | Typeface | Used for | Licence | Copyright | Licence text |
| --- | --- | --- | --- | --- | --- |
| `unbounded-var.woff2` | Unbounded | the title in the header | SIL Open Font License 1.1 | Copyright 2022 The Unbounded Project Authors (https://github.com/googlefonts/unbounded) | `unbounded-OFL.txt` |
| `instrument-sans-var.woff2` | Instrument Sans | every sentence and the buttons | SIL Open Font License 1.1 | Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans) | `instrument-sans-OFL.txt` |
| `jetbrains-mono-var.woff2` | JetBrains Mono | the device code | SIL Open Font License 1.1 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | `jetbrains-mono-OFL.txt` |

Each licence text is the `OFL.txt` of that typeface's own project, copied unchanged (compared with `cmp` against the
file as downloaded from the project's repository: no difference), and its first line is the copyright line in the table.
The same copyright line is written inside each font file (its name table), which was read from the three files here and
matches. The three texts are the same licence and differ only in that line (and, in the JetBrains Mono one, in the address
given for the licence's own page).

Where the files came from: copied from a font folder where the same files were already kept, and compared with
`cmp` against the copies there (no difference). That folder's notes say the Unbounded and Instrument Sans files are the
`latin-wght-normal` files of the `@fontsource-variable/unbounded` and `@fontsource-variable/instrument-sans` packages;
that was not compared again here. The JetBrains Mono file is from JetBrains' own project and was compared with nothing.

The Open Font License lets each file be used, embedded and passed on with a page as long as this notice travels with it
and a font is not sold on its own. The three licence texts sit beside the font files for that reason: a font file added
here needs its own licence text beside it, named in this table (`src/font-licences.test.ts` checks it). The page's route
serves the three font files and nothing else in this folder, so these texts and this file are in the repository and in the
assets, not at an address the page answers.
