// Settings, Nexus, Sign in: while the sign-in waits for the owner to allow it, the settings tab shows the code as text a person can select,
// with a Copy button beside Cancel that puts exactly that code on the clipboard and says Copied for two seconds. Run for real: the tab
// over a stand-in for Obsidian's own classes (fake-obsidian.ts, as screens-modal.test.ts does), the real sign-in, and the in-memory
// Nexus (world.ts) that issues the code, so the code that is copied is checked to be one Nexus gave out.
// It runs in Node with a page installed by hand (installDom), as vitest's own browser-like environment cannot be told that `obsidian`
// is the stand-in.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_FOR_MS } from "../src/copied";
import { POLL_EVERY_MS } from "../src/sign-in";
import type { PluginData } from "../src/types";
import { Notice, type Setting } from "./fake-obsidian";
import { installDom } from "./screens-world";
import { bodyOf, deviceRoutes, emptyNexus, forbidFetch, newLog, nexusOver, openWorld, type World } from "./world";

vi.mock("obsidian", () => import("./fake-obsidian"));

const { NexusSettingTab } = await import("../src/settings");

let world: World;
let removeDom: () => void;

beforeAll(async () => {
  removeDom = installDom();
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
  Notice.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

afterAll(() => removeDom());

/** The timers the tab asked the page for: the sign-in's wait between polls, and the Copied button's two seconds. */
interface Timer {
  ms: number;
  run: () => void;
  stopped: boolean;
}

/** The settings tab of a plugin that is set up and signed out, with a page whose clipboard and clock are written down. */
function openTab() {
  const state: PluginData = { address: world.address, user: world.user, token: null, cursor: null, notes: {} };
  const plugin = {
    state,
    keyHolder: { isUnlocked: false },
    setup: { lock: () => undefined },
    openSetup: () => undefined,
    engine: { status: () => "Signed out. Open the Nexus settings and sign in.", sync: async () => undefined },
    http: nexusOver(newLog(), { online: true }),
    deviceName: () => "Test iPhone",
    signInLabel: () => "Test iPhone",
    save: async () => undefined,
    showStatus: () => undefined,
  };
  const timers: Timer[] = [];
  const written: string[] = [];
  const opened: string[] = [];
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, ms: number) => timers.push({ ms, run, stopped: false }) - 1,
    clearTimeout: (id: number) => void (timers[id]!.stopped = true),
    open: (link: string) => void opened.push(link),
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void written.push(text) } });
  const tab = new NexusSettingTab({} as never, plugin as never);
  tab.display();
  const account = (): Setting => (tab as unknown as { containerEl: { settings: Setting[] } }).containerEl.settings.find((setting) => setting.name === "Account")!;
  return { tab, account, timers, written, opened };
}

/** Lets the sign-in get as far as waiting for the owner: Nexus has issued the code, and the tab shows it. */
async function untilWaiting(timers: Timer[]): Promise<void> {
  for (let turn = 0; turn < 200 && !timers.some((timer) => timer.ms === POLL_EVERY_MS); turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(timers.some((timer) => timer.ms === POLL_EVERY_MS), "the sign-in began and is waiting for the owner").toBe(true);
}

/** The Copy and Cancel buttons are looked up again each time: the tab draws itself anew when the sign-in shows its code. */
const codeShown = (account: Setting): string => account.descEl.querySelector("strong")!.textContent!;
const buttonsOf = (account: Setting): string[] => account.buttons.map((button) => button.text);

describe("Settings, Nexus, Sign in: the sign-in code", () => {
  it("shows the code as selectable text with Copy beside Cancel; Copy puts exactly that code on the clipboard and says Copied", async () => {
    const { account, timers, written, opened } = openTab();
    expect(buttonsOf(account()), "before signing in there is only Sign in").toEqual(["Sign in"]);
    account().buttons[0]!.clicked();
    await untilWaiting(timers);

    // The code is text in the page, in the form Nexus writes it, and a person can select it.
    const shown = codeShown(account());
    expect(shown).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const strong = account().descEl.querySelector("strong")!;
    expect(strong.className).toBe("nexus-selectable");
    expect(readFileSync(path.join(process.cwd(), "styles.css"), "utf8")).toMatch(/\.nexus-selectable \{[^}]*user-select: text;/);
    expect(account().descEl.querySelector("a")?.getAttribute("href"), "the link is still there").toBe(opened[0]);
    expect(buttonsOf(account())).toEqual(["Copy", "Cancel"]);

    // Copy: exactly the code on the clipboard, and it is a code Nexus issued.
    account().buttons[0]!.clicked();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(written).toEqual([shown]);
    expect(bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).pending(written[0]!)).label, "Nexus knows the code that was copied").toBe("Test iPhone");
    expect(buttonsOf(account())).toEqual(["Copied", "Cancel"]);

    // Two seconds later it says Copy again.
    const copied = timers.find((timer) => timer.ms === COPIED_FOR_MS)!;
    copied.run();
    expect(buttonsOf(account())).toEqual(["Copy", "Cancel"]);

    // Cancel ends the wait: the sign-in stops at its next poll and says nothing.
    account().buttons[1]!.clicked();
    expect(buttonsOf(account())).toEqual(["Sign in"]);
    timers.find((timer) => timer.ms === POLL_EVERY_MS)!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(Notice.messages).toEqual([]);
  });

  it("does not offer Copy before Nexus has handed the code over", async () => {
    const { account, timers } = openTab();
    account().buttons[0]!.clicked();
    // The tab has drawn the waiting line but the code has not come yet.
    expect(buttonsOf(account())).toEqual(["Cancel"]);
    await untilWaiting(timers);
    expect(buttonsOf(account())).toEqual(["Copy", "Cancel"]);
    account().buttons[1]!.clicked();
    timers.find((timer) => timer.ms === POLL_EVERY_MS)!.run();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("says so in a notice when the clipboard refuses, and the button still says Copy", async () => {
    const { account, timers } = openTab();
    account().buttons[0]!.clicked();
    await untilWaiting(timers);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("no")) } });
    account().buttons[0]!.clicked();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(Notice.messages).toEqual(["The code could not be copied. Select it and copy it by hand."]);
    expect(buttonsOf(account())).toEqual(["Copy", "Cancel"]);
    account().buttons[1]!.clicked();
    timers.find((timer) => timer.ms === POLL_EVERY_MS)!.run();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
