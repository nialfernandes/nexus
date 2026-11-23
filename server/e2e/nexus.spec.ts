// The Nexus page (public/nexus/index.html, /nexus/), looked at in a real browser at the two widths that matter: 375 px (a phone) and
// 1280 px (a desktop), in Sydney's time zone so the times read "Sat 12 Sep · 12:00". The page's own files are served as they are in
// public/nexus, and Nexus is the fake in src/__fixtures__/nexus-page-answers.ts (the same fake src/nexus-page.test.ts runs the page's script
// against, held there to the real routes' answers wherever a real route exists), so what is checked here is the page: the worked example
// from the owner secret to Undo, the page signed out, Nexus's words for a refused call, its layout and its light colours. Each state the boards
// draw, held against that board's picture, is e2e/nexus-boards.spec.ts.
//
// The Undo wait is passed with Playwright's clock (`page.clock`), not by waiting.
//
// Run it with: npm run test:browser --workspace nexus-server   (on the build box: through playwright-turn.sh).

import { expect, test, type Page } from "@playwright/test";
import { GONE_EXPIRED } from "../src/__fixtures__/approve-answers";
import { FAKE_OWNER_SECRET, WORKED, taken, workedIdentities } from "../src/__fixtures__/nexus-page-answers";
import { LONG_WAIT, expectNoSidewaysScroll, open, serve, signIn, style } from "./nexus-browser";

// The colours as the browser computes them (the approval page's tokens, which this page reads): the slab teal, the ground, the card, the ink.
const TEAL = "rgb(47, 205, 184)";
const GROUND = "rgb(238, 237, 234)";
const WHITE = "rgb(255, 255, 255)";
const INK = "rgb(15, 16, 19)";
const RED = "rgb(198, 32, 32)";
const BOARD_RED = "rgb(220, 38, 38)";

test.use({ timezoneId: "Australia/Sydney", permissions: ["clipboard-read", "clipboard-write"] });

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 678 : 800 } });

    /** The layout the page is drawn with at this width: a phone fills it, a desktop is one column of at most 720 px with cards of at most 420 px. */
    async function expectLayout(page: Page, card: string) {
      const slab = await page.locator(".slab").boundingBox();
      const box = await page.locator(card).first().boundingBox();
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
      for (const hidden of ["#signed-in", "#slab-actions", "#people", "#waiting", "#undo", "#command", ".tabs"]) await expect(page.locator(hidden), `${hidden} is not shown`).toBeHidden();
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
      await expect(page.locator("#people")).toBeVisible();
      await expect(page.locator("#slab-actions")).toBeVisible();
      expect(fake.calls.filter((call) => call.route === "identities").map((call) => call.secret), "none, the wrong one, the right one").toEqual([null, "b".repeat(64), FAKE_OWNER_SECRET]);
      // Nothing is kept: no cookie and no storage hold the secret.
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length]))).toBe("[0,0]");
    });

    test("worked example: you with a MacBook, scribe with a device and an iPhone waiting, Allow, add lab-m with its command and Copy, remove scribe with Undo", async ({ page }, testInfo) => {
      const fake = await serve(page);
      await open(page);
      await signIn(page);
      const picture = async (name: string) => testInfo.attach(name, { body: await page.screenshot({ animations: "disabled", caret: "hide" }), contentType: "image/png" });

      // Board 26b: who is connected, with the device waiting as a strip at the top and the list's line gone.
      await expect(page.locator(".person__name")).toHaveText(["you", "scribe"]);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);
      await expect(page.locator(".device__when")).toHaveText(["added Sat 12 Sep", "last used Sun 13 Sep · 09:30", "added Mon 14 Sep", "last used never"]);
      await expect(page.locator(".strip__words")).toHaveText("iPhone wants in");
      await expect(page.locator(".strip__code")).toHaveText("NW18D-NK7HZ");
      await expect(page.locator("#line")).toBeHidden();
      const strip = (await page.locator(".strip").boundingBox())!;
      const firstCard = (await page.locator(".person").first().boundingBox())!;
      expect(strip.y + strip.height, "the strip is above the list").toBeLessThanOrEqual(firstCard.y);
      await expectLayout(page, ".strip");
      await expectLayout(page, ".person");
      await expectLayout(page, ".tabs");
      await picture("board 26b: a device waiting");

      // Allow approves it, and the iPhone is listed under you: board 26.
      await page.getByRole("button", { name: "Allow iPhone", exact: true }).click();
      await expect(page.locator(".strip")).toHaveCount(0);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "iPhone", "scribe-box"]);
      expect(fake.callsTo("device/approve", "POST").map((call) => call.body), "approved once, by its code").toEqual([{ code: WORKED.waiting.code }]);
      await picture("board 26: connected");

      // Add (the bar's) opens board 27: the name, with Add dim.
      await page.locator("#add-open").click();
      await expect(page.locator("#title")).toHaveText("add an agent");
      await expect(page.locator("#add-go")).toBeDisabled();
      await expectLayout(page, "#add-card");
      await picture("board 27: add an agent");

      // Board 28: lab-m is added, and the command to run on it is shown with Copy, and that it is waiting.
      await page.locator("#agent-name").pressSequentially("lab-m");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator("#command-text")).toHaveText("nexus-agent join lab-m > lab-m.env");
      await expect(page.locator("#line")).toHaveText("lab-m is added. Run this on the agent.");
      await expect(page.locator("#waiting-for")).toHaveText("waiting for lab-m");
      expect(fake.callsTo("identity", "POST").map((call) => call.body)).toEqual([{ name: "lab-m", kind: "agent" }]);
      await expectLayout(page, "#command");
      const inside = await page.evaluate(() => {
        const card = document.querySelector("#command")!.getBoundingClientRect();
        const text = document.querySelector("#command-text")!.getBoundingClientRect();
        return text.left >= card.left && text.right <= card.right;
      });
      expect(inside, "the command sits inside its card").toBe(true);
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(page.locator("#copy")).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText()), "the clipboard holds the command").toBe("nexus-agent join lab-m > lab-m.env");
      await picture("board 28: agent added, waiting");

      // Back on the list lab-m is there with no devices. Opening scribe is board 29; Remove agent goes back to the list with Undo (29a).
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["you", "scribe", "lab-m"]);
      await expect(page.locator(".person").nth(2).locator(".card__quiet")).toHaveText("No devices.");
      await page.getByRole("button", { name: "scribe", exact: true }).click();
      await expect(page.locator("#title")).toHaveText("scribe");
      await page.getByRole("button", { name: "Remove agent", exact: true }).click();
      await expect(page.locator("#title")).toHaveText("connected");
      await expect(page.locator(".person__name")).toHaveText(["you", "lab-m"]);
      await expect(page.locator(".undo__words")).toHaveText("scribe removed, its devices stopped");
      await expectLayout(page, ".undo__item");
      await page.clock.runFor(1000);
      expect(fake.callsTo("identity/remove"), "inside the wait, nothing is sent").toEqual([]);
      await page.getByRole("button", { name: "Undo scribe removed, its devices stopped", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["you", "scribe", "lab-m"]);
      await expect(page.locator("#undo")).toBeHidden();
      await page.clock.runFor(LONG_WAIT);
      expect(fake.callsTo("identity/remove"), "Undo really put it back: nothing was sent however long it waited").toEqual([]);

      // Remove it again: this time the call goes, once, when the wait has passed.
      await page.getByRole("button", { name: "scribe", exact: true }).click();
      await page.getByRole("button", { name: "Remove agent", exact: true }).click();
      await expect(page.locator(".person__name")).toHaveText(["you", "lab-m"]);
      await page.clock.runFor(1000);
      expect(fake.callsTo("identity/remove"), "still inside the wait").toEqual([]);
      await page.clock.runFor(LONG_WAIT);
      await expect.poll(() => fake.callsTo("identity/remove", "POST").map((call) => call.body)).toEqual([{ name: "scribe" }]);
      await expect(page.locator(".person__name")).toHaveText(["you", "lab-m"]);
      await expect(page.locator("#undo")).toBeHidden();
      expect(fake.identities.map((who) => who.name), "Nexus no longer has it").toEqual(["nial", "lab-m"]);
    });

    test("removing a device is the same: gone at once, back with Undo, and token/revoke only after the wait", async ({ page }) => {
      const fake = await serve(page, { knownOwner: true });
      await open(page);
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);

      await page.getByRole("button", { name: "Remove scribe-box", exact: true }).click();
      await expect(page.locator(".device__label")).toHaveText(["MacBook"]);
      await expect(page.locator(".person__name")).toHaveText(["you", "scribe"]);
      await expect(page.locator(".undo__words")).toHaveText("scribe-box removed");
      await page.getByRole("button", { name: "Undo scribe-box removed", exact: true }).click();
      await expect(page.locator(".device__label")).toHaveText(["MacBook", "scribe-box"]);
      await page.clock.runFor(LONG_WAIT);
      expect(fake.callsTo("token/revoke")).toEqual([]);

      await page.getByRole("button", { name: "Remove scribe-box", exact: true }).click();
      await page.clock.runFor(LONG_WAIT);
      await expect.poll(() => fake.callsTo("token/revoke", "POST").map((call) => call.body)).toEqual([{ id: WORKED.agentDevice.id }]);
      await expect(page.locator(".device__label")).toHaveText(["MacBook"]);
    });

    test("a refused call shows Nexus's own words, and a name that is already an agent the drawn words: a code that ran out, and a name taken", async ({ page }) => {
      const fake = await serve(page, { knownOwner: true });
      await open(page);

      await page.locator("#add-open").click();
      await page.locator("#agent-name").pressSequentially("scribe");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator("#agent-hint")).toHaveText("There's already an agent called scribe.");
      expect(await style(page, "#agent-hint", "color"), "in the red the board draws").toBe(BOARD_RED);
      expect(taken("scribe").error, "Nexus's own words for it are not the drawn ones").not.toBe("There's already an agent called scribe.");
      await expect(page.locator("#command")).toBeHidden();
      await page.getByRole("button", { name: "Back", exact: true }).click();

      fake.ranOut.add(WORKED.waiting.code);
      await page.getByRole("button", { name: "Allow iPhone", exact: true }).click();
      await expect(page.locator("#alert")).toHaveText(GONE_EXPIRED.error);
      expect(await style(page, "#alert", "color"), "in the red the approval page uses for a fault").toBe(RED);
      await expect(page.locator(".strip")).toHaveCount(0);
      await expectNoSidewaysScroll(page, "the refusals");
    });

    test("a long list scrolls under the tabs, which stay in view, and a long name wraps inside its card", async ({ page }) => {
      const agents = Array.from({ length: 14 }, (_, at) => ({
        name: at === 0 ? "a-very-long-agent-name-that-has-no-place-to-break-but-must-not-widen-the-page" : `agent-${at}`,
        kind: "agent" as const, owner: false, createdAt: null, devices: [],
      }));
      await serve(page, { knownOwner: true, waiting: [], identities: [...workedIdentities().slice(0, 1), ...agents] });
      await open(page);
      await expect(page.locator(".person")).toHaveCount(15);
      const height = (await page.viewportSize())!.height;
      const document = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(document, "the list is longer than the window").toBeGreaterThan(height);
      const tabs = (await page.locator(".tabs").boundingBox())!;
      expect(tabs.y + tabs.height, "the tabs are in view without scrolling").toBeLessThanOrEqual(height);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const scrolled = (await page.locator(".tabs").boundingBox())!;
      expect(scrolled.y + scrolled.height, "and at the end of it").toBeLessThanOrEqual(height);
      expect(scrolled.y, "and still on screen").toBeGreaterThan(0);
      await expectNoSidewaysScroll(page, "a long list with a long name");
    });

    test("is drawn in its own three typefaces and the approval page's light colours, and the head's icons are served", async ({ page }) => {
      await serve(page, { knownOwner: true });
      await open(page);
      await expect(page.locator(".person").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, "")).sort());
      expect(loaded, "the three typefaces were fetched and read").toEqual(["Instrument Sans", "JetBrains Mono", "Unbounded"]);
      expect(await style(page, ".slab__title", "font-family")).toContain("Unbounded");
      expect(await style(page, ".device__label", "font-family")).toContain("Instrument Sans");
      expect(await style(page, ".strip__code", "font-family")).toContain("JetBrains Mono");

      expect(await style(page, ".slab", "background-color"), "the teal slab").toBe(TEAL);
      expect(await style(page, "body", "background-color"), "the sand-grey ground").toBe(GROUND);
      expect(await style(page, ".person", "background-color"), "the white card").toBe(WHITE);
      expect(await style(page, ".strip", "background-color"), "the white strip").toBe(WHITE);
      expect(await style(page, ".strip", "border-top-color"), "with the slab's teal at its edge").toBe(TEAL);
      expect(await style(page, ".strip .pill--main", "background-color"), "Allow is ink").toBe(INK);
      expect(await style(page, ".strip .pill--main", "color"), "with white words").toBe(WHITE);
      expect(await style(page, ".person__name", "font-size")).toBe("14px");
      expect(await style(page, ".device .pill", "height"), "Remove is a 30 px pill").toBe("30px");
      expect(await style(page, ".tab--open", "background-color"), "the open tab is teal").toBe(TEAL);
      await expectNoSidewaysScroll(page, "the page");

      // The head names the app icon and the browser can fetch each file.
      const icons = await page.evaluate(() => [...document.querySelectorAll("link[rel~='icon'], link[rel='apple-touch-icon']")].map((link) => (link as HTMLLinkElement).href));
      expect(icons.map((href) => new URL(href).pathname)).toEqual(["/nexus/icon.svg", "/nexus/icon-192.png", "/nexus/icon-512.png", "/nexus/apple-touch-icon.png"]);
      for (const href of icons) {
        const status = await page.evaluate(async (address) => (await fetch(address)).status, href);
        expect(status, `${href} is served`).toBe(200);
      }
    });
  });
}

test("has no dark set: a browser that asks for dark gets the same light page", async ({ browser }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 375, height: 678 } });
    const page = await context.newPage();
    await serve(page, { knownOwner: true });
    await open(page);
    await expect(page.locator(".person").first()).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `the browser really asks for ${colorScheme}`).toBe(colorScheme === "dark");
    expect(await style(page, "body", "background-color"), `the ground with a ${colorScheme} browser`).toBe(GROUND);
    expect(await style(page, ".person", "background-color"), `the card with a ${colorScheme} browser`).toBe(WHITE);
    expect(await style(page, ".device__label", "color"), `the ink with a ${colorScheme} browser`).toBe(INK);
    expect(await style(page, "html", "color-scheme"), "the page asks for the light scheme alone").toBe("light");
    await context.close();
  }
});
