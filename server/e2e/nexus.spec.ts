// The Nexus page (public/nexus/index.html, /nexus/), looked at in a real browser at the two widths that matter: 375 px (a phone) and
// 1280 px (a desktop), in Sydney's time zone so the times read "Sat 12 Sep · 12:00". The page's own files are served as they are in
// public/nexus, and Nexus is the fake in src/__fixtures__/nexus-page-answers.ts (the same fake src/nexus-page.test.ts runs the page's script
// against, held there to the real routes' answers wherever a real route exists), so what is checked here is the page: the worked example
// from the owner secret to Undo, the page signed out, Nexus's words for a refused call, its layout and its light colours.
//
// The Undo wait is passed with Playwright's clock (`page.clock`), not by waiting.
//
// Run it with: npm run test:browser --workspace nexus-server   (on the build box: through playwright-turn.sh).

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { GONE_EXPIRED } from "../src/__fixtures__/approve-answers";
import { FAKE_OWNER_SECRET, FAKE_OWNER_SECRET_HEADER, FakeNexus, NEXUS_PAGE, WORKED, taken, type FakeOptions } from "../src/__fixtures__/nexus-page-answers";

const ORIGIN = "https://nexus.example.test";
const PUBLIC = path.join(import.meta.dirname, "..", "public", "nexus");
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
};

/** Stands in for the Worker: the page's files come from disk, and Nexus's routes are answered by the fake. */
async function serve(page: Page, options: FakeOptions = {}): Promise<FakeNexus> {
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
async function open(page: Page) {
  await page.clock.install();
  await page.goto(`${ORIGIN}${NEXUS_PAGE}`);
}

/** Types the owner secret into the page and sends it. */
async function signIn(page: Page, secret = FAKE_OWNER_SECRET) {
  await page.locator("#secret").fill(secret);
  await page.locator("#owner-go").click();
}

/** The page does not scroll sideways: nothing is wider than the window. */
async function expectNoSidewaysScroll(page: Page, what: string) {
  const [scroll, window] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, `${what}: the page is no wider than the window`).toBeLessThanOrEqual(window!);
}

const style = (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

// The colours as the browser computes them (the approval page's tokens, which this page reads): the slab teal, the ground, the card, the ink.
const TEAL = "rgb(47, 205, 184)";
const GROUND = "rgb(238, 237, 234)";
const WHITE = "rgb(255, 255, 255)";
const INK = "rgb(15, 16, 19)";
const RED = "rgb(198, 32, 32)";

/** What a window of Nexus's own time passes: past any Undo wait. */
const LONG_WAIT = 60_000;

test.use({ timezoneId: "Australia/Sydney", permissions: ["clipboard-read", "clipboard-write"] });

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 678 : 800 } });

    /** The layout the page is drawn with at this width: a phone fills it, a desktop is one column of at most 720 px with cards of at most 420 px. */
    async function expectLayout(page: Page, card: string) {
      const slab = await page.locator(".slab").boundingBox();
      const box = await page.locator(card).boundingBox();
      if (width === 375) {
        expect(slab!.width, "the slab spans the phone").toBe(375);
        expect(box!.width, `${card} is the width less a 16 px margin each side`).toBe(375 - 32);
      } else {
        expect(slab!.width, "the column is 720 px wide").toBe(720);
        expect(slab!.x, "and centred").toBe((1280 - 720) / 2);
        expect(box!.width, `${card} keeps its phone proportions: at most 420 px`).toBe(420);
      }
      await expectNoSidewaysScroll(page, card);
    }

    test("signed out, it asks for the owner secret and shows nothing else; a wrong one is called wrong; the right one shows the page", async ({ page }) => {
      const fake = await serve(page);
      await open(page);

      await expect(page.locator("#secret")).toBeVisible();
      await expect(page.locator("#title")).toHaveText("connected");
      await expect(page.locator("#line")).toHaveText("Only the owner can see this.");
      for (const hidden of ["#signed-in", "#connected-card", "#add-card", "#waiting", "#undo", "#command"]) await expect(page.locator(hidden), `${hidden} is not shown`).toBeHidden();
      expect(await page.locator("body").innerText(), "no name, device or code of Nexus's is on the page").not.toMatch(/nial|scribe|MacBook|iPhone|K7QM/);
      await expectLayout(page, "#owner");

      await signIn(page, "b".repeat(64));
      await expect(page.locator("#owner-alert")).toHaveText("That is not the owner secret.");
      await expect(page.locator("#secret")).toHaveAttribute("aria-invalid", "true");
      expect(await style(page, "#secret", "outline-color"), "the wrong field is red").toBe(RED);
      expect(await page.locator("#secret").inputValue(), "and is emptied").toBe("");
      await expect(page.locator("#signed-in")).toBeHidden();

      await signIn(page);
      await expect(page.locator("#owner")).toBeHidden();
      await expect(page.locator("#connected-card")).toBeVisible();
      expect(fake.calls.filter((call) => call.route === "identities").map((call) => call.secret), "none, the wrong one, the right one").toEqual([null, "b".repeat(64), FAKE_OWNER_SECRET]);
      // Nothing is kept: no cookie and no storage hold the secret.
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length]))).toBe("[0,0]");
    });

    test("worked example: nial then scribe with their devices, the iPhone strip, Allow, add lab-m with its command and Copy, remove scribe with Undo", async ({ page }) => {
      const fake = await serve(page);
      await open(page);
      await signIn(page);

      // Who is connected: the owner, then the agent, each with its devices, in the Sat 12 Sep · 12:00 form.
      await expect(page.locator(".person__name")).toHaveText(["nial", "scribe"]);
      await expect(page.locator(".person .tag")).toHaveText(["owner", "agent"]);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);
      await expect(page.locator(".device__when")).toHaveText([
        "Added Sat 12 Sep · 12:00", "Last used Sun 13 Sep · 09:30",
        "Added Mon 14 Sep · 08:05", "Last used never",
      ]);
      // The device waiting is a strip at the top, above who is connected, with Allow and Deny and the code the device shows.
      await expect(page.locator(".strip__words")).toHaveText("iPhone wants to sign in as nial.");
      await expect(page.locator(".strip__code")).toHaveText("NW18D-NK7HZ");
      const strip = (await page.locator(".strip").boundingBox())!;
      const connected = (await page.locator("#connected-card").boundingBox())!;
      expect(strip.y + strip.height, "the strip is above the list").toBeLessThanOrEqual(connected.y);
      await expectLayout(page, ".strip");
      await expectLayout(page, "#connected-card");

      // Allow approves it, and the iPhone is listed under nial.
      await page.getByRole("button", { name: "Allow iPhone", exact: true }).click();
      await expect(page.locator(".strip")).toHaveCount(0);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "iPhone", "scribe-box"]);
      expect(fake.callsTo("device/approve", "POST").map((call) => call.body), "approved once, by its code").toEqual([{ code: WORKED.waiting.code }]);

      // Add lab-m: it is listed with no devices, and its command is shown with Copy, and the key is said to be handed over in Obsidian.
      await expect(page.locator("#command")).toBeHidden();
      await page.locator("#agent-name").fill("lab-m");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["nial", "scribe", "lab-m"]);
      await expect(page.locator(".person").nth(2).locator(".card__quiet")).toHaveText("No devices.");
      const commandText = `NEXUS_ADDRESS=${ORIGIN}/nexus/api nexus-agent sign-in --identity lab-m --label lab-m`;
      await expect(page.locator("#command-text")).toHaveText(commandText);
      await expect(page.locator("#command-note")).toContainText("The key is handed over in Obsidian, on a device that holds it, never on this page.");
      expect(fake.callsTo("identity", "POST").map((call) => call.body)).toEqual([{ name: "lab-m", kind: "agent" }]);
      await expectLayout(page, "#add-card");
      const inside = await page.evaluate(() => {
        const card = document.querySelector("#add-card")!.getBoundingClientRect();
        const text = document.querySelector("#command-text")!.getBoundingClientRect();
        return text.left >= card.left && text.right <= card.right;
      });
      expect(inside, "the long command wraps inside its card").toBe(true);
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(page.locator("#copy")).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText()), "the clipboard holds the command").toBe(commandText);

      // Remove scribe: the row goes at once, with Undo, and nothing is sent. Undo puts it back, and still nothing is sent.
      await page.getByRole("button", { name: "Remove scribe", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["nial", "lab-m"]);
      await expect(page.locator(".undo__words")).toHaveText("scribe removed.");
      await expectLayout(page, ".undo__item");
      await page.clock.runFor(1000);
      expect(fake.callsTo("identity/remove"), "inside the wait, nothing is sent").toEqual([]);
      await page.getByRole("button", { name: "Undo scribe removed.", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["nial", "scribe", "lab-m"]);
      await expect(page.locator("#undo")).toBeHidden();
      await page.clock.runFor(LONG_WAIT);
      expect(fake.callsTo("identity/remove"), "Undo really put it back: nothing was sent however long it waited").toEqual([]);

      // Remove it again: this time the call goes, once, when the wait has passed.
      await page.getByRole("button", { name: "Remove scribe", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["nial", "lab-m"]);
      await page.clock.runFor(1000);
      expect(fake.callsTo("identity/remove"), "still inside the wait").toEqual([]);
      await page.clock.runFor(LONG_WAIT);
      await expect.poll(() => fake.callsTo("identity/remove", "POST").map((call) => call.body)).toEqual([{ name: "scribe" }]);
      await expect(page.locator(".person__name")).toHaveText(["nial", "lab-m"]);
      await expect(page.locator("#undo")).toBeHidden();
      expect(fake.identities.map((who) => who.name), "Nexus no longer has it").toEqual(["nial", "lab-m"]);
    });

    test("removing a device is the same: gone at once, back with Undo, and token/revoke only after the wait", async ({ page }) => {
      const fake = await serve(page, { knownOwner: true });
      await open(page);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);

      await page.getByRole("button", { name: "Remove scribe-box", exact: true }).click();
      await expect(page.locator(".device__label")).toHaveText(["MacBook"]);
      await expect(page.locator(".person__name")).toHaveText(["nial", "scribe"]);
      await page.getByRole("button", { name: "Undo scribe-box removed.", exact: true }).click();
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);
      await page.clock.runFor(LONG_WAIT);
      expect(fake.callsTo("token/revoke")).toEqual([]);

      await page.getByRole("button", { name: "Remove scribe-box", exact: true }).click();
      await page.clock.runFor(LONG_WAIT);
      await expect.poll(() => fake.callsTo("token/revoke", "POST").map((call) => call.body)).toEqual([{ id: WORKED.agentDevice.id }]);
      await expect(page.locator(".device__label")).toHaveText(["MacBook"]);
    });

    test("a refused call shows Nexus's own words: a name taken, and a code that ran out", async ({ page }) => {
      const fake = await serve(page, { knownOwner: true });
      await open(page);

      await page.locator("#agent-name").fill("scribe");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator("#add-alert")).toHaveText(taken("scribe").error);
      expect(await style(page, "#add-alert", "color"), "in the red the approval page uses for a fault").toBe(RED);
      await expect(page.locator("#command")).toBeHidden();

      fake.ranOut.add(WORKED.waiting.code);
      await page.getByRole("button", { name: "Allow iPhone", exact: true }).click();
      await expect(page.locator("#alert")).toHaveText(GONE_EXPIRED.error);
      await expect(page.locator(".strip")).toHaveCount(0);
      await expectNoSidewaysScroll(page, "the refusals");
    });

    test("is drawn in its own three typefaces and the approval page's light colours", async ({ page }) => {
      const fake = await serve(page, { knownOwner: true });
      await open(page);
      await expect(page.locator("#connected-card")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, "")).sort());
      expect(loaded, "the three typefaces were fetched and read").toEqual(["Instrument Sans", "JetBrains Mono", "Unbounded"]);
      expect(await style(page, ".slab__title", "font-family")).toContain("Unbounded");
      expect(await style(page, ".person__name", "font-family")).toContain("Instrument Sans");
      expect(await style(page, ".device__when", "font-family")).toContain("JetBrains Mono");

      expect(await style(page, ".slab", "background-color"), "the teal slab").toBe(TEAL);
      expect(await style(page, "body", "background-color"), "the sand-grey ground").toBe(GROUND);
      expect(await style(page, "#connected-card", "background-color"), "the white card").toBe(WHITE);
      expect(await style(page, ".strip", "background-color"), "the white strip").toBe(WHITE);
      expect(await style(page, ".strip", "outline-color"), "with the slab's teal at its edge").toBe(TEAL);
      expect(await style(page, ".strip .pill--main", "background-color"), "Allow is ink").toBe(INK);
      expect(await style(page, ".strip .pill--main", "color"), "with white words").toBe(WHITE);
      expect(await style(page, ".card__title", "font-size")).toBe("15px");
      expect(await style(page, ".device .pill", "height"), "Remove is the small pill").toBe("26px");
      await expectNoSidewaysScroll(page, "the page");
    });
  });
}

test("has no dark set: a browser that asks for dark gets the same light page", async ({ browser }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 375, height: 678 } });
    const page = await context.newPage();
    const fake = await serve(page, { knownOwner: true });
    await open(page);
    await expect(page.locator("#connected-card")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `the browser really asks for ${colorScheme}`).toBe(colorScheme === "dark");
    expect(await style(page, "body", "background-color"), `the ground with a ${colorScheme} browser`).toBe(GROUND);
    expect(await style(page, "#connected-card", "background-color"), `the card with a ${colorScheme} browser`).toBe(WHITE);
    expect(await style(page, ".person__name", "color"), `the ink with a ${colorScheme} browser`).toBe(INK);
    expect(await style(page, "html", "color-scheme"), "the page asks for the light scheme alone").toBe("light");
    await context.close();
  }
});
