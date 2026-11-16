# Fonts the approval page uses

The page loads nothing from outside Nexus, so its three typefaces are served from here (to the owner only, like the
rest of the page: see `src/plugs/cloudflare/page.ts`). Each is a variable font, Latin characters only.

| File | Typeface | Used for | Licence |
| --- | --- | --- | --- |
| `unbounded-var.woff2` | Unbounded | the title in the header | SIL Open Font License 1.1 |
| `instrument-sans-var.woff2` | Instrument Sans | every sentence and the buttons | SIL Open Font License 1.1 |
| `jetbrains-mono-var.woff2` | JetBrains Mono | the device code | SIL Open Font License 1.1, copyright The JetBrains Mono Project Authors |

Where they came from: copied from the font folder of the design system these screens were drawn in, and compared with
`cmp` against the copies there (no difference). That folder's notes say the Unbounded and Instrument Sans files are the
`latin-wght-normal` files of the `@fontsource-variable/unbounded` and `@fontsource-variable/instrument-sans` packages;
that was not compared again here. The JetBrains Mono file is from JetBrains' own project and was compared with nothing.
The licence's full text is still to be put beside each file.

The Open Font License lets each file be used, embedded and passed on with a page as long as this notice travels with it
and a font is not sold on its own.
