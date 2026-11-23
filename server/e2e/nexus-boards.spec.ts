// The Nexus page, one test for each state the boards 26 to 30 draw (docs/design/nexus-page), reached in a real browser at the width the boards are
// drawn at, 375 px, at twice the size. Each test gets the page into the state, checks what the board says is on it (its words, its buttons, what is
// not there), and holds a screenshot of the page against the board's own picture: the share of pixels that differ must stay small, and the page, the
// picture and where they differ are attached to the test, side by side, for a person to look at. The people, dates and codes are the boards' own
// sample data (nexus-page-answers.ts, BOARD), used only so the same screen is drawn.
//
// The Undo wait is passed with Playwright's clock (`page.clock`), not by waiting. The progress bar of board 28 moves while Nexus waits; for the
// picture it is held still, as a person who asks for less motion sees it.
//
// Run it with: npm run test:browser --workspace nexus-server   (on the build box: through playwright-turn.sh).

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BOARD, FakeNexus, boardIdentities, type FakeOptions } from "../src/__fixtures__/nexus-page-answers";
import { AT_MOST_DIFFERENT, BOARD_BROWSER_ARGS } from "./nexus-board-settings";
import { LONG_WAIT, expectNoSidewaysScroll, likenessToBoard, mostColouredPixel, open, serve, signIn, style } from "./nexus-browser";

const TEAL = "rgb(47, 205, 184)";
const GROUND = "rgb(238, 237, 234)";
const WHITE = "rgb(255, 255, 255)";
const INK = "rgb(15, 16, 19)";
const INK_SOFT = "rgb(58, 58, 64)";
const BOARD_RED = "rgb(220, 38, 38)";
const CODE_BOX = "rgb(242, 241, 238)";

// The browser is started with the flags of nexus-board-settings.ts: at twice the size for real, and drawing grey, unhinted letters as the boards
// have them. The flags have to be set for the whole file, which is why they are here and not in the shared configuration.
test.use({
  launchOptions: { args: BOARD_BROWSER_ARGS },
  timezoneId: "Australia/Sydney",
  permissions: ["clipboard-read", "clipboard-write"],
  viewport: { width: 375, height: 640 },
  deviceScaleFactor: 2,
});

// A person who asks for less motion sees the progress bar of board 28 standing where it is drawn, which is what the picture shows.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

/** Opens the page as the owner, with the people of the boards, in a window as tall as the board's page is. */
async function opened(page: Page, height: number, options: FakeOptions = {}): Promise<FakeNexus> {
  await page.setViewportSize({ width: 375, height });
  const fake = await serve(page, { knownOwner: true, identities: boardIdentities(), waiting: [], ...options });
  await open(page);
  await expect(page.locator("#signed-in")).toBeVisible();
  return fake;
}

/** The page held against a board's picture. */
async function expectLikeBoard(page: Page, testInfo: TestInfo, board: string, height: number, only?: Array<[number, number]>): Promise<void> {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const { differing, worstRows } = await likenessToBoard(page, testInfo, board, height, only);
  if (process.env.NEXUS_LOOKS) console.log(`LIKENESS ${board} ${(differing * 100).toFixed(3)}% at ${worstRows.join(",")}`);
  testInfo.annotations.push({ type: "likeness", description: `${board}: ${(differing * 100).toFixed(2)}% of pixels differ; most at ${worstRows.join(", ")} px` });
  expect(differing, `${board}: the page is like its picture (most differences at ${worstRows.join(", ")} px from the top)`).toBeLessThanOrEqual(AT_MOST_DIFFERENT);
}

/** The top bar as every board draws it: teal, 52 px high, rounded 22 px below, the mark, a thin divider and the lowercase title. */
async function expectSlab(page: Page, title: string): Promise<void> {
  const slab = (await page.locator(".slab").boundingBox())!;
  expect(slab.width, "the bar spans the phone").toBe(375);
  expect(slab.height, "one slim line: 10 px, 32 px, 10 px").toBe(52);
  expect(await style(page, ".slab", "background-color")).toBe(TEAL);
  expect(await style(page, ".slab", "border-bottom-left-radius")).toBe("22px");
  expect(await style(page, ".slab", "border-bottom-right-radius")).toBe("22px");
  await expect(page.locator(".slab__mark")).toHaveText("nexus");
  expect(await style(page, ".slab__mark", "font-size")).toBe("22px");
  expect(await style(page, ".slab__mark", "font-weight")).toBe("900");
  expect(await style(page, ".slab__divider", "width")).toBe("1px");
  expect(await style(page, ".slab__divider", "height")).toBe("16px");
  await expect(page.locator("#title")).toHaveText(title);
  expect(await style(page, "#title", "font-size")).toBe("15px");
  expect(await style(page, "#title", "font-weight")).toBe("700");
  expect(await style(page, "#title", "font-family")).toContain("Unbounded");
  expect(await style(page, "body", "background-color")).toBe(GROUND);
}

/** The tabs as every board draws them: a white bar, connected then settings last, the open one filled teal. */
async function expectTabs(page: Page, open: "connected" | "settings"): Promise<void> {
  await expect(page.locator(".tab")).toHaveText(["connected", "settings"]);
  const tabs = (await page.locator(".tabs").boundingBox())!;
  expect(tabs.width, "the bar is the width less a 16 px margin each side").toBe(375 - 32);
  expect(tabs.height, "40 px tabs and 4 px round them").toBe(48);
  expect(await style(page, ".tabs", "background-color")).toBe(WHITE);
  expect(await style(page, ".tabs", "border-radius")).toBe("16px");
  const filled = (name: string) => style(page, name === "connected" ? "#tab-connected" : "#tab-settings", "background-color");
  expect(await filled(open), "the open tab is filled teal").toBe(TEAL);
  expect(await filled(open === "connected" ? "settings" : "connected"), "the other is plain").toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(`#tab-${open}`)).toHaveAttribute("aria-current", "page");
  expect(await style(page, ".tab", "border-radius")).toBe("12px");
}

/** The page's own text, for what must not be on it. */
const wholeText = (page: Page) => page.locator("body").innerText();

// ── the list: boards 26, 26a, 26b, 26c ────────────────────────────────────────

test("board 26, connected: you, then each agent, each in its own card with its devices, Add and the Ask sparkle on the bar", async ({ page }, testInfo) => {
  await opened(page, 648);

  await expectSlab(page, "connected");
  await expect(page.locator("#line")).toHaveText("Everything that can read your notes.");
  await expect(page.locator(".person__name")).toHaveText(["you", "scribe", "lab-m"]);
  expect(await style(page, ".person__name", "font-family")).toContain("Unbounded");
  expect(await style(page, ".person__name", "font-size")).toBe("14px");
  expect(await style(page, ".person__name", "font-weight")).toBe("700");
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "MacBook", "Mac mini", "lab-m"]);
  await expect(page.locator(".device__when")).toHaveText([
    "added Sat 21 Nov", "last used Mon 23 Nov · 11:40",
    "added Sat 21 Nov", "last used Mon 23 Nov · 09:12",
    "added Sun 22 Nov", "last used Mon 23 Nov · 11:40",
    "added Sun 22 Nov", "last used Sun 22 Nov · 18:05",
  ]);
  expect(await style(page, ".device__label", "font-size")).toBe("15px");
  expect(await style(page, ".device__label", "font-weight")).toBe("600");
  expect(await style(page, ".device__when", "font-size")).toBe("13px");
  expect(await style(page, ".device__when", "color")).toBe(INK_SOFT);
  // Each person is a white card, 16 px round, 14 px inside.
  expect(await style(page, ".person", "background-color")).toBe(WHITE);
  expect(await style(page, ".person", "border-radius")).toBe("16px");
  expect(await style(page, ".person", "padding")).toBe("14px");
  // A quiet Remove for each device and none for the people: one in a fixed slot at the card's right, 30 px high.
  const removes = page.getByRole("button", { name: /^Remove /, exact: false });
  await expect(removes).toHaveCount(4);
  expect(await style(page, ".device .pill", "height")).toBe("30px");
  expect(await style(page, ".device .pill", "border-top-width")).toBe("1.5px");
  const right = await removes.evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().right)));
  expect(new Set(right).size, "the Remove pills line up").toBe(1);
  // The bar: Add (a white pill with a plus), then the Ask sparkle; no Aus Apps.
  const add = (await page.locator("#add-open").boundingBox())!;
  const ask = (await page.locator("#ask").boundingBox())!;
  expect(add.height).toBe(30);
  expect(await style(page, "#add-open", "background-color")).toBe(WHITE);
  expect(add.x + add.width, "Add is left of the sparkle, 14 px away").toBe(ask.x - 14);
  expect(ask.x + ask.width, "and the sparkle ends at the bar's 16 px margin").toBe(375 - 16);
  await expect(page.locator("#apps")).toBeHidden();
  await expect(page.locator("#back")).toBeHidden();
  await expectTabs(page, "connected");
  await expect(page.locator(".strip")).toHaveCount(0);
  await expectNoSidewaysScroll(page, "board 26");
  await expectLikeBoard(page, testInfo, "26-nexus-connected-light", 648);
});

test("board 26a, only you: just the owner's card, one line and a main Add an agent that opens the add form (and so does Add on the bar)", async ({ page }, testInfo) => {
  await opened(page, 639, { identities: boardIdentities().slice(0, 1) });

  await expect(page.locator(".person__name")).toHaveText(["you"]);
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "MacBook"]);
  await expect(page.locator(".only-you")).toBeVisible();
  await expect(page.locator(".only-you__words")).toHaveText("No agent is connected yet. Add one to let it read your notes.");
  const add = page.getByRole("button", { name: "Add an agent", exact: true });
  expect(await style(page, "#add-first", "background-color"), "a main pill: ink").toBe(INK);
  expect(await style(page, "#add-first", "color")).toBe(WHITE);
  expect((await add.boundingBox())!.height).toBe(30);
  await expect(page.locator("#add-open"), "the bar's Add is still there").toBeVisible();
  // The line and the button are centred in the room between the card and the tabs.
  const card = (await page.locator(".person").boundingBox())!;
  const tabs = (await page.locator(".tabs").boundingBox())!;
  const block = (await page.locator(".only-you__words").boundingBox())!;
  const button = (await add.boundingBox())!;
  const room = { top: card.y + card.height + 10, bottom: tabs.y - 10 };
  expect((block.y + button.y + button.height) / 2, "in the middle of the room").toBeCloseTo((room.top + room.bottom) / 2, 0);
  expect(block.y - 0, "and not above it").toBeGreaterThanOrEqual(room.top);
  await expectLikeBoard(page, testInfo, "26a-only-you-light", 639);

  await add.click();
  await expect(page.locator("#title")).toHaveText("add an agent");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("#add-open").click();
  await expect(page.locator("#title"), "the bar's Add does the same").toHaveText("add an agent");
});

test("the letters are grey, as the boards draw them, on a machine that asks for sub-pixel text too: no coloured edge on the device rows", async ({ page }) => {
  await opened(page, 648);
  // A device's words, ink on a white card: with grey letters no pixel is more than a few steps from grey.
  await expect(page.locator(".device__when").first()).toHaveText("added Sat 21 Nov");
  expect(await mostColouredPixel(page, ".device__text"), "the device's words have no coloured edge").toBeLessThanOrEqual(12);
});

test("a list with an agent is not the only-you list", async ({ page }) => {
  await opened(page, 648);
  await expect(page.locator(".only-you")).toBeHidden();
});

test("board 26b, a device waiting: a strip at the top outlined in teal with the device and its code, Allow and Deny, and the list's line gives way to it", async ({ page }, testInfo) => {
  const fake = await opened(page, 735, { waiting: [{ ...BOARD.waiting }] });

  await expect(page.locator(".strip")).toHaveCount(1);
  await expect(page.locator(".strip__words")).toHaveText("iPhone wants in");
  await expect(page.locator(".strip__code")).toHaveText("ABCD-EFGH");
  expect(await style(page, ".strip__code", "font-family")).toContain("JetBrains Mono");
  expect(await style(page, ".strip__code", "letter-spacing")).toBe("1.04px");
  expect(await style(page, ".strip", "border-top-color"), "outlined in teal").toBe(TEAL);
  expect(await style(page, ".strip", "border-top-width")).toBe("1.5px");
  expect(await style(page, ".strip", "background-color")).toBe(WHITE);
  expect(await style(page, ".strip .pill--main", "background-color"), "Allow is ink").toBe(INK);
  expect(await style(page, ".strip .pill--main", "color")).toBe(WHITE);
  expect(await style(page, ".strip .pill--quiet", "border-top-width"), "Deny is the quiet outline").toBe("1.5px");
  await expect(page.locator("#line"), "the list's line is not drawn while a device waits").toBeHidden();
  const strip = (await page.locator(".strip").boundingBox())!;
  const firstCard = (await page.locator(".person").first().boundingBox())!;
  expect(strip.y, "the strip is the first thing under the bar, 16 px down").toBe(52 + 16);
  expect(strip.y + strip.height + 10, "10 px above the first card").toBe(firstCard.y);
  await expectLikeBoard(page, testInfo, "26b-a-device-waiting-light", 735);

  // After a tap both pills go dim so nothing is sent twice.
  const allow = page.getByRole("button", { name: "Allow iPhone", exact: true });
  const deny = page.getByRole("button", { name: "Deny iPhone", exact: true });
  await allow.click();
  await expect(page.locator(".strip")).toHaveCount(0);
  expect(fake.callsTo("device/approve", "POST").map((call) => call.body)).toEqual([{ code: "ABCD-EFGH" }]);
  await expect(page.locator("#line")).toHaveText("iPhone can use Nexus now.");
  await expect(deny).toHaveCount(0);
});

test("board 26b, Deny; a device keeps Allow and Deny, and an agent's sign-in says whose it wants to be, gives the key's place instead of Allow, and keeps Deny", async ({ page }) => {
  const fake = await opened(page, 735, { waiting: [{ ...BOARD.waiting }, { code: "PQRS-TUVW", label: "scribe-box", identity: "scribe", deviceKey: null, deviceCode: "PQRS-TUVW" }] });
  await expect(page.locator(".strip__words")).toHaveText(["iPhone wants in", "scribe-box wants in as scribe"]);
  // The device keeps Allow and Deny; the agent's sign-in has Deny and the words of board 28a, and no Allow: it is let in in Obsidian.
  await expect(page.getByRole("button", { name: "Allow iPhone", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Deny iPhone", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Allow scribe-box", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny scribe-box", exact: true })).toHaveCount(1);
  await expect(page.locator(".strip__key")).toHaveText("Open Obsidian on your Mac to give scribe the key.");
  expect(await page.locator(".strip").nth(1).getByRole("button").count(), "Deny alone").toBe(1);
  expect(await page.locator(".strip").first().getByRole("button").count(), "the device's strip: Allow and Deny").toBe(2);
  const deny = page.getByRole("button", { name: "Deny iPhone", exact: true });
  const allow = page.getByRole("button", { name: "Allow iPhone", exact: true });
  await deny.click();
  await expect(page.locator(".strip")).toHaveCount(1);
  expect(fake.callsTo("device/deny", "POST").map((call) => call.body)).toEqual([{ code: "ABCD-EFGH" }]);
  expect(fake.callsTo("device/approve")).toEqual([]);
  await expect(page.locator("#line")).toHaveText("iPhone was not given a token.");
  await expect(allow).toHaveCount(0);

  // Deny on the agent's strip sends the same and takes the strip away.
  await page.getByRole("button", { name: "Deny scribe-box", exact: true }).click();
  await expect(page.locator(".strip")).toHaveCount(0);
  expect(fake.callsTo("device/deny", "POST").map((call) => call.body)).toEqual([{ code: "ABCD-EFGH" }, { code: "PQRS-TUVW" }]);
  expect(fake.callsTo("device/approve"), "nothing on this page ever allowed an agent").toEqual([]);
});

test("board 26c, removed: the row is gone at once and an ink bar above the tabs says MacBook removed with Undo in teal; Undo puts it back, and after eight seconds the removal stays", async ({ page }, testInfo) => {
  const fake = await opened(page, 640);

  await page.getByRole("button", { name: "Remove MacBook", exact: true }).click();
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "Mac mini", "lab-m"]);
  await expect(page.locator(".undo__words")).toHaveText("MacBook removed");
  const bar = (await page.locator(".undo__item").boundingBox())!;
  const tabs = (await page.locator(".tabs").boundingBox())!;
  expect(bar.height, "an ink bar 40 px high").toBe(40);
  expect(bar.width).toBe(375 - 32);
  expect(await style(page, ".undo__item", "background-color")).toBe(INK);
  expect(await style(page, ".undo__item", "border-radius")).toBe("999px");
  expect(await style(page, ".undo__words", "color")).toBe(WHITE);
  expect(await style(page, ".undo__button", "color"), "Undo in teal").toBe(TEAL);
  expect(await style(page, ".undo__button", "font-weight")).toBe("600");
  expect(tabs.y - (bar.y + bar.height), "above the tabs").toBe(18);
  await expectLikeBoard(page, testInfo, "26c-removed-light", 640);
  expect(fake.callsTo("token/revoke"), "nothing is sent while Undo can still be used").toEqual([]);

  // Undo puts the row back and the bar goes; nothing is ever sent.
  await page.getByRole("button", { name: "Undo MacBook removed", exact: true }).click();
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "MacBook", "Mac mini", "lab-m"]);
  await expect(page.locator(".undo")).toBeHidden();
  await page.clock.runFor(LONG_WAIT);
  expect(fake.callsTo("token/revoke")).toEqual([]);

  // Left alone, the bar leaves after eight seconds and the removal stays.
  await page.getByRole("button", { name: "Remove MacBook", exact: true }).click();
  await page.clock.runFor(7_000);
  await expect(page.locator(".undo__item")).toHaveCount(1);
  expect(fake.callsTo("token/revoke")).toEqual([]);
  await page.clock.runFor(1_500);
  await expect(page.locator(".undo")).toBeHidden();
  await expect.poll(() => fake.callsTo("token/revoke", "POST").map((call) => call.body)).toEqual([{ id: "tok-board-macbook" }]);
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "Mac mini", "lab-m"]);
});

// ── adding an agent: boards 27, 27a, 28, 28a ──────────────────────────────────

test("board 27, add an agent: a back chevron before the title, the Ask sparkle alone on the right, one pill field with scribe in grey, and Add dim until the name is good", async ({ page }, testInfo) => {
  await opened(page, 639);
  await page.locator("#add-open").click();

  await expectSlab(page, "add an agent");
  await expect(page.locator("#back")).toBeVisible();
  await expect(page.locator("#add-open"), "the page action is not on this view").toBeHidden();
  await expect(page.locator("#ask")).toBeVisible();
  await expect(page.locator("#line")).toHaveText("Give the agent a name. It reads every note once it has the key.");
  await expect(page.locator("#add-form .field__label")).toHaveText("AGENT NAME");
  expect(await style(page, "#add-form .field__label", "font-family")).toContain("JetBrains Mono");
  const field = page.locator("#agent-name");
  await expect(field).toHaveAttribute("placeholder", "scribe");
  await expect(field).toHaveValue("");
  const box = (await field.boundingBox())!;
  expect(box.height, "a 30 px pill").toBe(30);
  expect(await style(page, "#agent-name", "border-top-width")).toBe("1.5px");
  expect(await style(page, "#agent-name", "border-top-left-radius")).toBe("999px");
  expect(await style(page, "#agent-name", "font-size")).toBe("13px");
  await expect(page.locator("#agent-hint")).toHaveText("Lower case letters, digits and hyphens.");
  expect(await style(page, "#agent-hint", "color")).toBe(INK_SOFT);
  const add = page.locator("#add-go");
  await expect(add).toBeDisabled();
  expect(await style(page, "#add-go", "opacity"), "dim").toBe("0.35");
  expect(await style(page, "#add-go", "background-color")).toBe(INK);
  await expect(page.locator("#view-connected")).toBeHidden();
  await expectTabs(page, "connected");
  await expectLikeBoard(page, testInfo, "27-add-an-agent-light", 639);

  // Anything but lower case letters, digits and hyphens is blocked as typed, and nothing says so but the one line under the field.
  await field.pressSequentially("Sc ri_b.E!");
  await expect(field).toHaveValue("crib");
  await expect(page.locator("#agent-hint")).toHaveText("Lower case letters, digits and hyphens.");
  await expect(add, "a good name turns Add on").toBeEnabled();
  expect(await style(page, "#add-go", "opacity")).toBe("1");
  await field.fill("");
  await field.pressSequentially("-x");
  await expect(add, "a name does not begin with a hyphen").toBeDisabled();
  await field.fill("");
  await expect(add).toBeDisabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#title"), "the chevron goes back to board 26").toHaveText("connected");
});

test("board 27a, name taken: the line under the field turns red and says there's already an agent called scribe, the outline turns red and Add stays dim; typing another name clears it at once", async ({ page }, testInfo) => {
  const fake = await opened(page, 639);
  await page.locator("#add-open").click();
  await page.locator("#agent-name").pressSequentially("scribe");
  await page.locator("#add-go").click();

  await expect(page.locator("#agent-hint")).toHaveText("There's already an agent called scribe.");
  expect(await style(page, "#agent-hint", "color")).toBe(BOARD_RED);
  expect(await style(page, "#agent-name", "border-top-color")).toBe(BOARD_RED);
  await expect(page.locator("#add-go")).toBeDisabled();
  await expect(page.locator("#agent-name")).toHaveValue("scribe");
  await expect(page.locator("#command")).toBeHidden();
  expect(fake.callsTo("identity", "POST").map((call) => call.body)).toEqual([{ name: "scribe", kind: "agent" }]);
  await expectLikeBoard(page, testInfo, "27a-name-taken-light", 639);

  await page.locator("#agent-name").pressSequentially("2");
  await expect(page.locator("#agent-hint")).toHaveText("Lower case letters, digits and hyphens.");
  expect(await style(page, "#agent-hint", "color")).toBe(INK_SOFT);
  expect(await style(page, "#agent-name", "border-top-color")).not.toBe(BOARD_RED);
  await expect(page.locator("#add-go")).toBeEnabled();
});

test("board 28, agent added, waiting: the command to run on the agent in a code box with Copy, and under a thin line waiting for it with the bar", async ({ page }, testInfo) => {
  const fake = await opened(page, 639, { identities: boardIdentities().slice(0, 1) });
  await page.locator("#add-open").click();
  await page.locator("#agent-name").pressSequentially("scribe");
  await page.locator("#add-go").click();

  await expect(page.locator("#line")).toHaveText("scribe is added. Run this on the agent.");
  await expect(page.locator("#add-card")).toBeHidden();
  await expect(page.locator("#command-label")).toHaveText("COMMAND");
  await expect(page.locator("#command-text")).toHaveText("nexus-agent join scribe > scribe.env");
  expect(await style(page, "#command-text", "background-color")).toBe(CODE_BOX);
  expect(await style(page, "#command-text", "border-radius")).toBe("8px");
  expect(await style(page, "#command-text", "font-family")).toContain("JetBrains Mono");
  expect(await style(page, "#command-text", "font-size")).toBe("12px");
  expect(await style(page, "#command-text", "padding")).toBe("10px 12px");
  await expect(page.locator("#copy")).toHaveText("Copy");
  expect(await style(page, "#copy", "background-color"), "Copy is the main pill").toBe(INK);
  await expect(page.locator("#waiting-for")).toHaveText("waiting for scribe");
  expect(await style(page, "#waiting-for", "font-weight")).toBe("600");
  expect((await page.locator(".progress").boundingBox())!.height).toBe(6);
  expect(await style(page, ".progress", "background-color")).toBe(CODE_BOX);
  expect(await style(page, ".progress__fill", "background-color")).toBe(TEAL);
  expect((await page.locator(".progress__fill").boundingBox())!.width, "96 px of it filled").toBe(96);
  expect(fake.callsTo("identity", "POST").map((call) => call.body)).toEqual([{ name: "scribe", kind: "agent" }]);
  await expectLikeBoard(page, testInfo, "28-agent-added-waiting-light", 639);

  // Copy hands over the command, says Copied for two seconds, then says Copy again.
  await page.locator("#copy").click();
  await expect(page.locator("#copy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("nexus-agent join scribe > scribe.env");
  await page.clock.runFor(1_900);
  await expect(page.locator("#copy")).toHaveText("Copied");
  await page.clock.runFor(200);
  await expect(page.locator("#copy")).toHaveText("Copy");
});

test("board 28, the bar moves while Nexus waits, and stands still for a person who asks for less motion", async ({ page, browser }) => {
  await opened(page, 639, { identities: boardIdentities().slice(0, 1) });
  await page.locator("#add-open").click();
  await page.locator("#agent-name").pressSequentially("scribe");
  await page.locator("#add-go").click();
  expect(await style(page, ".progress__fill", "animation-name"), "less motion: no animation").toBe("none");

  const context = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 375, height: 639 }, timezoneId: "Australia/Sydney" });
  const moving = await context.newPage();
  await serve(moving, { knownOwner: true, identities: boardIdentities().slice(0, 1), waiting: [] });
  await open(moving);
  await moving.locator("#add-open").click();
  await moving.locator("#agent-name").pressSequentially("scribe");
  await moving.locator("#add-go").click();
  expect(await style(moving, ".progress__fill", "animation-name")).toBe("progress-moves");
  expect(await style(moving, ".progress__fill", "animation-iteration-count")).toBe("infinite");
  await context.close();
});

test("board 28a, agent joined, key to hand over: once the agent has a working device the card says so and sends the person to Obsidian, with no key, no field and no button", async ({ page }, testInfo) => {
  const fake = await opened(page, 640, { identities: boardIdentities().slice(0, 1) });
  await page.locator("#add-open").click();
  await page.locator("#agent-name").pressSequentially("scribe");
  await page.locator("#add-go").click();
  await expect(page.locator("#waiting-for")).toBeVisible();

  // The agent runs the command: its sign-in waits above the card, and the page asks again every few seconds.
  fake.waiting.push({ code: "PQRS-TUVW", label: "Mac mini", identity: "scribe", deviceKey: null, deviceCode: "PQRS-TUVW", expiresAt: Date.now() + 600_000 });
  await page.clock.runFor(5_000);
  await expect(page.locator(".strip__words")).toHaveText("Mac mini wants in as scribe");
  await expect(page.locator(".strip__key"), "the key is given in Obsidian").toHaveText("Open Obsidian on your Mac to give scribe the key.");
  await expect(page.getByRole("button", { name: "Allow Mac mini", exact: true }), "an agent has no Allow here").toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny Mac mini", exact: true })).toHaveCount(1);
  await expect(page.locator("#command"), "still waiting").toBeVisible();
  // In Obsidian the owner lets it in, with the key (board 31): Nexus now has a device for scribe, and the page, asking again, says so.
  expect(fake.answer("POST", "device/approve", { code: "PQRS-TUVW" }, null).status).toBe(200);
  await page.clock.runFor(5_000);

  await expect(page.locator("#joined")).toBeVisible();
  await expect(page.locator("#line")).toHaveText("scribe has joined.");
  await expect(page.locator(".joined__title")).toHaveText("scribe joined");
  await expect(page.locator(".joined__words")).toHaveText("Open Obsidian on your Mac to give scribe the key.");
  await expect(page.locator("#joined .card__quiet")).toHaveText("The key never comes to this website.");
  expect((await page.locator(".joined__tick").boundingBox())!.width).toBe(20);
  expect(await style(page, ".joined__tick", "background-color")).toBe(TEAL);
  await expect(page.locator("#command")).toBeHidden();
  await expect(page.locator(".strip")).toHaveCount(0);
  // No key, no field and no button on the card: only text.
  await expect(page.locator("#joined input, #joined textarea, #joined button, #joined a")).toHaveCount(0);
  expect(await wholeText(page), "the key is not on this page").not.toMatch(/recovery key|vault key|password/i);
  await expectLikeBoard(page, testInfo, "28a-agent-joined-key-to-hand-over-light", 640);

  // The agent is now on the list with its device.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".person__name")).toHaveText(["you", "scribe"]);
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "MacBook", "Mac mini"]);
});

// ── one agent: boards 29 and 29a ──────────────────────────────────────────────

test("board 29, an agent: tapping scribe on the list opens its card with its devices, when it joined and Remove agent at the bottom; the chevron goes back", async ({ page }, testInfo) => {
  await opened(page, 640);
  await page.getByRole("button", { name: "scribe", exact: true }).click();

  await expectSlab(page, "scribe");
  await expect(page.locator("#back")).toBeVisible();
  await expect(page.locator("#line")).toHaveText("Joined Sun 22 Nov. It reads every note.");
  await expect(page.locator("#agent-card .person__name")).toHaveText("scribe");
  await expect(page.locator("#agent-card .device__label")).toHaveText("Mac mini");
  await expect(page.locator("#view-agent .person")).toHaveCount(1);
  const remove = page.getByRole("button", { name: "Remove agent", exact: true });
  const box = (await remove.boundingBox())!;
  expect(box.height).toBe(30);
  expect(box.x + box.width / 2, "centred").toBeCloseTo(375 / 2, 0);
  expect(await style(page, "#remove-agent", "border-top-width"), "a quiet pill").toBe("1.5px");
  const tabs = (await page.locator(".tabs").boundingBox())!;
  expect(tabs.y - (box.y + box.height), "at the bottom: 12 px and the page's 10 px above the tabs").toBe(22);
  await expectTabs(page, "connected");
  await expectLikeBoard(page, testInfo, "29-an-agent-light", 640);

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".person__name")).toHaveText(["you", "scribe", "lab-m"]);
});

test("board 29a, agent removed: Remove agent puts the person back on the list without scribe, with an ink bar saying scribe removed, its devices stopped and Undo; Undo brings it back, left alone it stays removed after eight seconds", async ({ page }, testInfo) => {
  const fake = await opened(page, 639);
  await page.getByRole("button", { name: "scribe", exact: true }).click();
  await page.getByRole("button", { name: "Remove agent", exact: true }).click();

  await expect(page.locator("#title")).toHaveText("connected");
  await expect(page.locator(".person__name")).toHaveText(["you", "lab-m"]);
  await expect(page.locator(".undo__words")).toHaveText("scribe removed, its devices stopped");
  expect(fake.callsTo("identity/remove"), "nothing is sent while Undo can be used").toEqual([]);
  await expectLikeBoard(page, testInfo, "29a-agent-removed-light", 639);

  await page.getByRole("button", { name: "Undo scribe removed, its devices stopped", exact: true }).click();
  await expect(page.locator(".person__name")).toHaveText(["you", "scribe", "lab-m"]);
  await expect(page.locator(".device__label")).toHaveText(["iPhone", "MacBook", "Mac mini", "lab-m"]);
  await page.clock.runFor(LONG_WAIT);
  expect(fake.callsTo("identity/remove"), "Undo cancelled it").toEqual([]);

  await page.getByRole("button", { name: "scribe", exact: true }).click();
  await page.getByRole("button", { name: "Remove agent", exact: true }).click();
  await page.clock.runFor(8_500);
  await expect(page.locator(".undo")).toBeHidden();
  await expect.poll(() => fake.callsTo("identity/remove", "POST").map((call) => call.body)).toEqual([{ name: "scribe" }]);
  await expect(page.locator(".person__name")).toHaveText(["you", "lab-m"]);
  expect(fake.identities.map((who) => who.name)).toEqual(["nial", "lab-m"]);
});

// ── Settings: board 30 ────────────────────────────────────────────────────────

test("board 30, settings: the last tab, Aus Apps in place of the sparkle, and Sign out; the rows that need the key are not built", async ({ page }, testInfo) => {
  await opened(page, 639);
  await page.getByRole("button", { name: "settings", exact: true }).click();

  await expectSlab(page, "settings");
  await expect(page.locator("#back")).toBeHidden();
  await expect(page.locator("#add-open")).toBeHidden();
  await expect(page.locator("#ask"), "Aus Apps stands in place of the sparkle").toBeHidden();
  const apps = page.getByRole("link", { name: "Aus Apps", exact: true });
  await expect(apps).toBeVisible();
  const appsBox = (await apps.boundingBox())!;
  expect(appsBox.height).toBe(30);
  expect(appsBox.x + appsBox.width, "at the bar's right margin").toBe(375 - 16);
  expect(await style(page, "#apps", "background-color"), "an ink pill").toBe(INK);
  expect(await style(page, "#apps", "color")).toBe(WHITE);
  expect(await style(page, "#apps", "text-decoration-line")).toBe("none");
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  const out = (await signOut.boundingBox())!;
  expect(out.height).toBe(30);
  expect(out.x + out.width, "at the right").toBe(375 - 16);
  expect(await style(page, "#sign-out", "border-top-width"), "a quiet pill").toBe("1.5px");
  await expect(page.locator("#view-connected")).toBeHidden();
  const words = await wholeText(page);
  expect(words, "a row that would need the vault key or the Recovery Key is not on this page").not.toMatch(/password|recovery key/i);
  await expectTabs(page, "settings");
  // Only the bar and the tabs are drawn as built: the email line and the two rows above Sign out are not.
  await expectLikeBoard(page, testInfo, "30-settings-light", 639, [[0, 52], [575, 639]]);

  await page.getByRole("button", { name: "connected", exact: true }).click();
  await expect(page.locator("#title")).toHaveText("connected");
  await expectTabs(page, "connected");
});

test("board 30, Sign out lets go of the owner secret the page holds and asks for it again, with nothing of Nexus's left on the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 639 });
  const fake = await serve(page);
  await open(page);
  await signIn(page);
  await expect(page.locator(".person__name").first()).toHaveText("you");
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  await expect(page.locator("#secret")).toBeVisible();
  await expect(page.locator("#line")).toHaveText("Only the owner can see this.");
  await expect(page.locator("#signed-in")).toBeHidden();
  await expect(page.locator("#slab-actions"), "the bar's buttons go with it").toBeHidden();
  await expect(page.locator("#title")).toHaveText("connected");
  expect(await wholeText(page), "nothing of Nexus's is left").not.toMatch(/scribe|MacBook|iPhone/);
  const before = fake.calls.length;
  await page.clock.runFor(LONG_WAIT);
  expect(fake.calls.length, "and the page asks Nexus nothing more").toBe(before);
  // The owner can sign in again.
  await signIn(page);
  await expect(page.locator(".person__name").first()).toHaveText("you");
  await expect(page.locator("#title")).toHaveText("connected");
});
