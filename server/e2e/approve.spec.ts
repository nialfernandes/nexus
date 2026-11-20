// The device approval page, looked at in a real browser at the two widths that matter: 375 px (a phone, the width the boards are drawn at)
// and 1280 px (a desktop). The page's own files are served as they are in public/nexus, and Nexus's answers are the shapes in
// src/__fixtures__/approve-answers.ts (which approval-page.test.ts holds to what the real routes answer), so what is checked here is the
// page: its owner-secret step, Allow, Deny and the two cards for a code that is finished, their words, their layout and their colours.
// What each tap sends and the rest of the flow are also run against the real Worker in src/approval-page-actions.test.ts, without a layout.
//
// Run it with: npm run test:browser --workspace nexus-server   (on the build box: through playwright-turn.sh).

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { API_APPROVE, API_DENY, API_PENDING, APPROVED, CODE, DENIED, GONE, GONE_EXPIRED, PAGE_PATH, PENDING, PENDING_NO_KEY } from "../src/__fixtures__/approve-answers";

const ORIGIN = "https://nexus.example.test";
const PUBLIC = path.join(import.meta.dirname, "..", "public", "nexus");
const OWNER_SECRET = "a".repeat(64);
const OWNER_SECRET_HEADER = "x-nexus-owner-secret";

/** The codes the page is opened with, which say what Nexus answers: a waiting sign-in, one that ran out, one that was used. */
const WAITING = CODE;
const RAN_OUT = "RANO-UTXX";
const USED = "USED-XXXX";

/** The files the page links, as the Worker serves them: only these. */
const FILES: Record<string, { file: string; type: string }> = {
  [PAGE_PATH]: { file: "approve.html", type: "text/html; charset=utf-8" },
  "/nexus/approve.css": { file: "approve.css", type: "text/css; charset=utf-8" },
  "/nexus/approve.js": { file: "approve.js", type: "text/javascript; charset=utf-8" },
  "/nexus/fonts/unbounded-var.woff2": { file: "fonts/unbounded-var.woff2", type: "font/woff2" },
  "/nexus/fonts/instrument-sans-var.woff2": { file: "fonts/instrument-sans-var.woff2", type: "font/woff2" },
  "/nexus/fonts/jetbrains-mono-var.woff2": { file: "fonts/jetbrains-mono-var.woff2", type: "font/woff2" },
};

/** What the page asked Nexus, in order. */
interface Call {
  method: string;
  path: string;
  code: string | null;
  body: unknown;
  secret: string | null;
}

/**
 * Stands in for the Worker. The page and its files come from disk. Nexus's routes answer as the fixtures say (`pending` is what
 * device/pending answers, the fixture's by default), and 401 until the owner is known: the browser holds the owner's cookie
 * (`knownOwner`), or the call carries the owner secret in its header.
 */
async function serve(page: Page, options: { knownOwner: boolean; pending?: Record<string, unknown> }): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const file = FILES[url.pathname];
    if (file) return route.fulfill({ status: 200, contentType: file.type, body: readFileSync(path.join(PUBLIC, file.file)) });

    const code = url.searchParams.get("code");
    const body = request.postData() === null ? null : JSON.parse(request.postData()!);
    const secret = request.headers()[OWNER_SECRET_HEADER] ?? null;
    calls.push({ method: request.method(), path: url.pathname, code, body, secret });
    const json = (status: number, answer: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(answer) });

    if (!options.knownOwner && secret === null) return json(401, { error: "Sign in as the owner first." });
    if (!options.knownOwner && secret !== OWNER_SECRET) return json(401, { error: "Sign in as the owner first." });
    const asked = code ?? (body as { code?: string } | null)?.code ?? null;
    if (asked === RAN_OUT) return json(410, GONE_EXPIRED);
    if (asked === USED) return json(410, GONE);
    if (url.pathname === API_PENDING) return json(200, options.pending ?? PENDING);
    if (url.pathname === API_APPROVE) return json(200, APPROVED);
    if (url.pathname === API_DENY) return json(200, DENIED);
    return json(404, { error: "no such route" });
  });
  return calls;
}

const open = async (page: Page, code: string) => page.goto(`${ORIGIN}${PAGE_PATH}?code=${code}`);

/** The page does not scroll sideways: nothing is wider than the window. */
async function expectNoSidewaysScroll(page: Page, what: string) {
  const [scroll, window] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, `${what}: the page is no wider than the window`).toBeLessThanOrEqual(window!);
}

const style = (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

// The colours as the browser computes them (the page's tokens): the slab teal, the ground, the card, the ink and the red.
const TEAL = "rgb(47, 205, 184)";
const GROUND = "rgb(238, 237, 234)";
const WHITE = "rgb(255, 255, 255)";
const INK = "rgb(15, 16, 19)";
const RED = "rgb(198, 32, 32)";

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 678 : 800 } });

    /** The layout the page is drawn with at this width: a phone fills it, a desktop is one column of at most 720 px with a card of at most 420 px. */
    async function expectLayout(page: Page, card: string) {
      const slab = await page.locator(".slab").boundingBox();
      const box = await page.locator(card).boundingBox();
      if (width === 375) {
        expect(slab!.width, "the slab spans the phone").toBe(375);
        expect(box!.width, "the card is the width less a 16 px margin each side").toBe(375 - 32);
      } else {
        expect(slab!.width, "the column is 720 px wide").toBe(720);
        expect(slab!.x, "and centred").toBe((1280 - 720) / 2);
        expect(box!.width, "the card keeps its phone proportions: at most 420 px").toBe(420);
      }
      await expectNoSidewaysScroll(page, card);
    }

    test("asks for the owner secret first, calls a wrong one wrong, and shows the question for the right one", async ({ page }) => {
      const calls = await serve(page, { knownOwner: false });
      await open(page, WAITING);

      await expect(page.locator("#secret")).toBeVisible();
      await expect(page.locator("#title")).toHaveText("new device");
      await expect(page.locator("#line")).toHaveText("Only the owner can answer a device.");
      await expect(page.locator("#ask")).toBeHidden();
      await expectLayout(page, "#owner");

      // A wrong secret: the field goes red, the words say so, and nothing is shown of the sign-in.
      await page.locator("#secret").fill("b".repeat(64));
      await page.locator("#owner-go").click();
      await expect(page.locator("#owner-alert")).toHaveText("That is not the owner secret.");
      await expect(page.locator("#secret")).toHaveAttribute("aria-invalid", "true");
      expect(await style(page, "#secret", "outline-color"), "the wrong field is red").toBe(RED);
      expect(await page.locator("#secret").inputValue(), "and is emptied").toBe("");
      await expect(page.locator("#ask")).toBeHidden();

      // The right one: the question, with the device's name and its code in boxes.
      await page.locator("#secret").fill(OWNER_SECRET);
      await page.locator("#owner-go").click();
      await expect(page.locator("#question")).toHaveText("Allow lab-m to use Nexus as agents?");
      await expect(page.locator("#owner")).toBeHidden();
      await expect(page.locator(".code__box")).toHaveCount(10);
      await expect(page.locator(".code__group")).toHaveCount(3);
      expect(await page.locator(".code__box").allTextContents(), "the code, as the new device shows it").toEqual([...PENDING.deviceCode.replace("-", "")]);
      await expectLayout(page, "#ask");

      expect(calls.map((call) => call.secret), "each call sent the secret in the header it was typed for: none, the wrong one, the right one").toEqual([null, "b".repeat(64), OWNER_SECRET]);
      // Nothing is kept: no cookie and no storage hold the secret, and the field is empty.
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length]))).toBe("[0,0]");
    });

    test("worked example: a new device 'MacBook' that shows the key code ABCD EFGH JK is shown by that name and that code, in groups of 4, 4 and 2", async ({ page }) => {
      await serve(page, { knownOwner: true, pending: { ...PENDING, label: "MacBook", deviceCode: "ABCDE-FGHJK" } });
      await open(page, WAITING);
      await expect(page.locator("#question")).toHaveText("Allow MacBook to use Nexus as agents?");
      await expect(page.locator(".code__label")).toHaveText("DEVICE CODE");
      expect(await page.locator(".code__group").evaluateAll((groups) => groups.map((group) => group.querySelectorAll(".code__box").length)), "the groups are 4, 4 and 2").toEqual([4, 4, 2]);
      expect(await page.locator(".code__group").evaluateAll((groups) => groups.map((group) => group.textContent)), "the code is read the way the new device draws it").toEqual(["ABCD", "EFGH", "JK"]);
      await expect(page.locator("#code")).toHaveAttribute("aria-label", "Device code ABCDEFGHJK");
      // Ten boxes on one row, none squeezed to nothing at the phone's width and none left over to wrap.
      const boxes = await page.locator(".code__box").evaluateAll((all) => all.map((box) => box.getBoundingClientRect()));
      expect(new Set(boxes.map((box) => Math.round(box.top))).size, "one row").toBe(1);
      expect(Math.min(...boxes.map((box) => box.width)), "each box is wide enough to read").toBeGreaterThanOrEqual(20);
      await expectLayout(page, "#ask");
    });

    test("a device that sent no key has no key code, and the page shows its sign-in code as it did", async ({ page }) => {
      await serve(page, { knownOwner: true, pending: PENDING_NO_KEY });
      await open(page, WAITING);
      await expect(page.locator("#question")).toHaveText("Allow lab-m to use Nexus as agents?");
      expect(await page.locator(".code__group").evaluateAll((groups) => groups.map((group) => group.textContent))).toEqual(["K7QM", "4XNP"]);
    });

    test("Allow sends the code and shows the allowed card", async ({ page }) => {
      const calls = await serve(page, { knownOwner: true });
      await open(page, WAITING);
      await expect(page.locator("#question")).toHaveText("Allow lab-m to use Nexus as agents?");
      await expect(page.locator("#title")).toHaveText("new device");
      await expect(page.locator("#line")).toHaveText("A device wants to sign in.");
      await expectLayout(page, "#ask");

      await page.getByRole("button", { name: "Allow" }).click();
      await expect(page.locator("#title")).toHaveText("allowed");
      await expect(page.locator("#said")).toHaveText("lab-m can use Nexus now.");
      await expect(page.locator("#mark-allowed")).toBeVisible();
      await expect(page.locator("#ask")).toBeHidden();
      expect(await style(page, "#mark-allowed", "background-color"), "the teal circle").toBe(TEAL);
      await expectLayout(page, "#result");
      expect(calls.filter((call) => call.method === "POST"), "one answer, and it is Allow").toEqual([
        { method: "POST", path: API_APPROVE, code: null, body: { code: WAITING }, secret: null },
      ]);
    });

    test("Deny sends the code and shows the denied card", async ({ page }) => {
      const calls = await serve(page, { knownOwner: true });
      await open(page, WAITING);
      await page.getByRole("button", { name: "Deny" }).click();
      await expect(page.locator("#title")).toHaveText("denied");
      await expect(page.locator("#said")).toHaveText("lab-m was not given a token.");
      await expect(page.locator("#mark-denied")).toBeVisible();
      await expect(page.locator("#ask")).toBeHidden();
      await expectLayout(page, "#result");
      expect(calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body])).toEqual([[API_DENY, { code: WAITING }]]);
    });

    test("a code that ran out says so in Nexus's words, with the red clock and no buttons", async ({ page }) => {
      const calls = await serve(page, { knownOwner: true });
      await open(page, RAN_OUT);
      await expect(page.locator("#title")).toHaveText("code ran out");
      await expect(page.locator("#said")).toHaveText("That code has run out.");
      await expect(page.locator("#mark-expired")).toBeVisible();
      await expect(page.locator("#mark-used")).toBeHidden();
      await expect(page.getByRole("button", { name: "Allow" })).toBeHidden();
      expect(await style(page, "#mark-expired", "background-color"), "the red circle's fill").toBe("rgb(253, 236, 238)");
      expect(await style(page, "#mark-expired .mark__icon", "stroke"), "and the red clock").toBe(RED);
      await expectLayout(page, "#result");
      expect(calls.filter((call) => call.method === "POST"), "nothing was sent").toEqual([]);
    });

    test("a code that was used says so in Nexus's words, with the red cross and no buttons", async ({ page }) => {
      const calls = await serve(page, { knownOwner: true });
      await open(page, USED);
      await expect(page.locator("#title")).toHaveText("code used");
      await expect(page.locator("#said")).toHaveText("That code was already used.");
      await expect(page.locator("#mark-used")).toBeVisible();
      await expect(page.locator("#mark-expired")).toBeHidden();
      await expect(page.getByRole("button", { name: "Allow" })).toBeHidden();
      await expectLayout(page, "#result");
      expect(calls.filter((call) => call.method === "POST"), "nothing was sent").toEqual([]);
    });

    test("is drawn in its own three typefaces and its light colours", async ({ page }) => {
      await serve(page, { knownOwner: true });
      await open(page, WAITING);
      await expect(page.locator("#question")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, "")).sort());
      expect(loaded, "the three typefaces were fetched and read").toEqual(["Instrument Sans", "JetBrains Mono", "Unbounded"]);
      expect(await style(page, ".slab__title", "font-family")).toContain("Unbounded");
      expect(await style(page, "#question", "font-family")).toContain("Instrument Sans");
      expect(await style(page, ".code__box", "font-family")).toContain("JetBrains Mono");

      expect(await style(page, ".slab", "background-color"), "the teal slab").toBe(TEAL);
      expect(await style(page, ".slab", "border-bottom-left-radius"), "rounded at the bottom").toBe("22px");
      expect(await style(page, "body", "background-color"), "the sand-grey ground").toBe(GROUND);
      expect(await style(page, "#ask", "background-color"), "the white card").toBe(WHITE);
      expect(await style(page, "#allow", "background-color"), "Allow is ink").toBe(INK);
      expect(await style(page, "#allow", "color"), "with white words").toBe(WHITE);
      expect(await style(page, ".slab__mark", "font-weight")).toBe("900");
      expect(await style(page, ".slab__title", "font-size")).toBe("15px");
    });
  });
}

test("has no dark set: a browser that asks for dark gets the same light page", async ({ browser }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 375, height: 678 } });
    const page = await context.newPage();
    await serve(page, { knownOwner: true });
    await open(page, WAITING);
    await expect(page.locator("#question")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `the browser really asks for ${colorScheme}`).toBe(colorScheme === "dark");
    expect(await style(page, "body", "background-color"), `the ground with a ${colorScheme} browser`).toBe(GROUND);
    expect(await style(page, "#ask", "background-color"), `the card with a ${colorScheme} browser`).toBe(WHITE);
    expect(await style(page, "#question", "color"), `the ink with a ${colorScheme} browser`).toBe(INK);
    expect(await style(page, "html", "color-scheme"), "the page asks for the light scheme alone").toBe("light");
    await context.close();
  }
});
