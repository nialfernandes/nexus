// The two settings that decide whether the Nexus page's picture checks (nexus-boards.spec.ts) pass: how much of a page may differ from its board, and
// how the browser draws letters. They are here, and not in the spec, so that src/nexus-boards-settings.test.ts can read the real values: the
// spec holds the allowed difference where it was, and the browser's letters are the board's. This file imports nothing, so a plain Node test can load it.

/**
 * How much of the page may differ from a board's picture. A pixel counts as different only if nothing within a css pixel of it in the other image
 * has its colour (nexus-browser.ts), and the boards' pages are drawn on half pixels, so what is left is the edges of some letters and the last
 * half pixel of the page: the pictures measure 0.2 to 0.8 percent. A misplaced row, button or colour is more, and the checks of sizes and
 * places in each test are what catch a smaller one.
 */
export const AT_MOST_DIFFERENT = 0.012;

/**
 * The flags the browser of the picture checks is started with.
 *
 * The boards are drawn at twice the size with 1.5 px outlines. A browser that only pretends to be twice the size draws a 1.5 px border 1 px
 * wide, so the browser starts at twice the size for real (the first flag) as well as being told so (deviceScaleFactor in the spec).
 *
 * The boards are drawn with grey letters and no font hinting (every letter pixel is a shade of its colour, and letters are not nudged onto
 * the pixel grid). What a browser draws depends on the machine's font settings. A machine that asks for sub-pixel text (the red, green and
 * blue stripes of a screen) draws the page's letters with coloured edges, which the picture comparison counts as different from the board on
 * every line of small text; that is what failed five boards on GitHub's machine (the same five fail in the lab when its settings are changed to
 * ask for sub-pixel text). The lab's own settings ask for grey letters, so the pictures passed there. The last two flags make the browser draw
 * grey letters and not nudge them, whatever the machine's settings say.
 */
export const BOARD_BROWSER_ARGS = ["--force-device-scale-factor=2", "--disable-lcd-text", "--font-render-hinting=none"];
