// What the Nexus page's browser specs (nexus.spec.ts, nexus-boards.spec.ts) share: a stand-in for the Worker that serves the page's own files from
// public/nexus and answers its calls with the fake Nexus (src/__fixtures__/nexus-page-answers.ts), the sign-in, and the look of a board held
// against the page. This file is not a spec: Playwright runs only the files that end in .spec.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { FAKE_OWNER_SECRET, FAKE_OWNER_SECRET_HEADER, FakeNexus, NEXUS_PAGE, type FakeOptions } from "../src/__fixtures__/nexus-page-answers";

export const ORIGIN = "https://nexus.example.test";
export const PUBLIC = path.join(import.meta.dirname, "..", "public", "nexus");
/** The drawn boards, kept beside the page (docs/design/nexus-page): each board's picture is png/<name>@2x.png. */
export const BOARDS = path.join(import.meta.dirname, "..", "..", "docs", "design", "nexus-page", "png");
const API = "/nexus/api/";

/** The files the page links, as the Worker serves them: only these. */
const FILES: Record<string, { file: string; type: string }> = {
  [NEXUS_PAGE]: { file: "index.html", type: "text/html; charset=utf-8" },
  "/nexus/nexus.css": { file: "nexus.css", type: "text/css; charset=utf-8" },
  "/nexus/nexus.js": { file: "nexus.js", type: "text/javascript; charset=utf-8" },
  "/nexus/approve.css": { file: "approve.css", type: "text/css; charset=utf-8" },
  "/nexus/fonts/unbounded-var.woff2": { file: "fonts/unbounded-var.woff2", type: "font/woff2" },
  "/nexus/fonts/instrument-sans-var.woff2": { file: "fonts/instrument-sans-var.woff2", type: "font/woff2" },
  "/nexus/fonts/jetbrains-mono-var.woff2": { file: "fonts/jetbrains-mono-var.woff2", type: "font/woff2" },
  "/nexus/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/nexus/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/nexus/icon-512.png": { file: "icon-512.png", type: "image/png" },
  "/nexus/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
};

/** Stands in for the Worker: the page's files come from disk, and Nexus's routes are answered by the fake. */
export async function serve(page: Page, options: FakeOptions = {}): Promise<FakeNexus> {
  const fake = new FakeNexus(options);
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const file = FILES[url.pathname];
    if (file) return route.fulfill({ status: 200, contentType: file.type, body: readFileSync(path.join(PUBLIC, file.file)) });
    if (!url.pathname.startsWith(API)) return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });

    const body = request.postData() === null ? null : JSON.parse(request.postData()!);
    const said = fake.answer(request.method(), url.pathname.slice(API.length) + url.search, body, request.headers()[FAKE_OWNER_SECRET_HEADER] ?? null);
    return route.fulfill({ status: said.status, contentType: "application/json", body: JSON.stringify(said.json) });
  });
  return fake;
}

/** Opens the page with the clock installed, so the Undo wait can be passed by hand. */
export async function open(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto(`${ORIGIN}${NEXUS_PAGE}`);
}

/** Types the owner secret into the page and sends it. */
export async function signIn(page: Page, secret = FAKE_OWNER_SECRET): Promise<void> {
  await page.locator("#secret").fill(secret);
  await page.locator("#owner-go").click();
}

/** The page does not scroll sideways: nothing is wider than the window. */
export async function expectNoSidewaysScroll(page: Page, what: string): Promise<void> {
  const [scroll, window] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, `${what}: the page is no wider than the window`).toBeLessThanOrEqual(window!);
}

/** One computed style of the first element that matches. */
export const style = (page: Page, selector: string, property: string): Promise<string> =>
  page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

/** What a window of Nexus's own time passes: past any Undo wait. */
export const LONG_WAIT = 60_000;

// ── a board's picture held against the page ───────────────────────────────────

/** How far a pixel's colour may be from the picture's before it counts as different: 0 to 255 in its furthest channel. */
const PIXEL_TOLERANCE = 48;
/** How far, in device pixels (twice the css pixels), the same pixel may sit from where the picture has it: one css pixel. */
const PIXEL_REACH = 2;

export interface Likeness {
  /** The share of the page's pixels that differ from the picture's, 0 to 1. */
  differing: number;
  /** The rows of 8 px (at 2x: 4 css px) in which the most pixels differ, most first, as css px from the top: where to look. */
  worstRows: number[];
}

/**
 * The page as it is now, a screenshot at twice its size, held against the top of a board's picture (the page part of the picture: its first
 * `height` css px, above the home indicator and the build notes). A third image, the page | the picture | where they differ, is attached to
 * the test so a person can look at them side by side. The two are decoded and compared in a second page of the browser, so no image library is needed.
 * `only` names the stretches of the page (css px from the top, from and to) to count, for a board with something the page does not build.
 */
export async function likenessToBoard(page: Page, testInfo: TestInfo, board: string, height: number, only?: Array<[number, number]>): Promise<Likeness> {
  await page.evaluate(() => document.fonts.ready);
  const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
  const picture = readFileSync(path.join(BOARDS, `${board}@2x.png`));
  const helper = await page.context().newPage();
  try {
    const result = await helper.evaluate(async ({ actual, expected, rows, tolerance, reach, ranges }) => {
      const load = (b64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("an image did not load"));
        image.src = `data:image/png;base64,${b64}`;
      });
      const [a, b] = await Promise.all([load(actual), load(expected)]);
      const width = a.naturalWidth;
      const draw = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = rows;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0, width, rows, 0, 0, width, rows);
        return context.getImageData(0, 0, width, rows);
      };
      const left = draw(a);
      const right = draw(b);
      const diff = new ImageData(width, rows);
      const perBand = new Map<number, number>();
      // A pixel is "the same" when a pixel within `reach` of it in the other image has about its colour: a letter half a pixel lower than
      // drawn is the same letter, a button a few pixels away is not.
      const near = (one: Uint8ClampedArray, other: Uint8ClampedArray, x: number, y: number): boolean => {
        const i = (y * width + x) * 4;
        for (let dy = -reach; dy <= reach; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = (yy * width + xx) * 4;
            if (Math.max(Math.abs(one[i]! - other[j]!), Math.abs(one[i + 1]! - other[j + 1]!), Math.abs(one[i + 2]! - other[j + 2]!)) <= tolerance) return true;
          }
        }
        return false;
      };
      let differing = 0;
      let counted = 0;
      for (let y = 0; y < rows; y++) {
        const counts = ranges.length === 0 || ranges.some(([from, to]) => y >= from * 2 && y < to * 2);
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const off = !near(left.data, right.data, x, y) || !near(right.data, left.data, x, y);
          if (counts) counted += 1;
          if (off && counts) {
            differing += 1;
            const band = Math.floor(y / 8);
            perBand.set(band, (perBand.get(band) ?? 0) + 1);
          }
          diff.data[i] = off ? 220 : 255;
          diff.data[i + 1] = off ? 38 : 255;
          diff.data[i + 2] = off ? 38 : 255;
          diff.data[i + 3] = 255;
        }
      }
      const out = document.createElement("canvas");
      out.width = width * 3 + 40;
      out.height = rows;
      const context = out.getContext("2d")!;
      context.fillStyle = "#888";
      context.fillRect(0, 0, out.width, out.height);
      context.putImageData(new ImageData(left.data, width, rows), 0, 0);
      context.putImageData(new ImageData(right.data, width, rows), width + 20, 0);
      context.putImageData(diff, width * 2 + 40, 0);
      const worst = [...perBand.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([band]) => band * 4);
      return { differing: differing / counted, worst, side: out.toDataURL("image/png").split(",")[1]! };
    }, { actual: shot.toString("base64"), expected: picture.toString("base64"), rows: height * 2, tolerance: PIXEL_TOLERANCE, reach: PIXEL_REACH, ranges: only ?? [] });
    const side = Buffer.from(result.side, "base64");
    await testInfo.attach(`${board}: the page | the board | where they differ`, { body: side, contentType: "image/png" });
    // To look at them without the test report: NEXUS_LOOKS=<folder> also writes each one there.
    if (process.env.NEXUS_LOOKS) {
      mkdirSync(process.env.NEXUS_LOOKS, { recursive: true });
      writeFileSync(path.join(process.env.NEXUS_LOOKS, `${board}.png`), side);
    }
    return { differing: result.differing, worstRows: result.worst };
  } finally {
    await helper.close();
  }
}
