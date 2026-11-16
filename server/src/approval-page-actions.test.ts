// What the approval page DOES, run for real: the page's own HTML and its own script (approve.js), as the Worker serves
// them to the owner, with Nexus answering through the real Worker and the real database. The owner opens the link a
// device was handed, sees "Allow <label> to use Nexus as <identity>?" with the device's code, and taps Allow or Deny. The
// words and the parts of each state are the ones drawn in docs/design/nexus: board 1 (the question), 2 (allowed),
// 3 (denied), 4 (the code ran out) and 5 (the code was used).
//
// THIS IS NOT A BROWSER TEST. It ports the old site's browser test of this page (the question and its two buttons,
// what each tap sends, a refusal in plain words, a label that is markup) without Playwright, because this package
// has no Playwright and `npm test` is vitest only. The page's script is run in a node:vm context against a small
// stand-in for the page (document.getElementById, createElement, textContent, hidden, disabled, click), and the page's
// calls go to the real Worker as the owner, so no answer in this file is written by hand. What the stand-in does not do,
// and so what is NOT checked anywhere in this package: how the page is laid out and whether it fits a phone or a desktop,
// the size of its buttons, the typefaces, and its colours (approval-page.test.ts reads the stylesheets, but nothing
// draws them, so how it looks next to the boards is looked at by eye when it changes).
//
// The stand-in is kept honest in two ways. An element exists only if the served HTML has an element with that id, and it
// starts hidden only if the HTML says `hidden`, so a page whose HTML lost an id or its `hidden` fails here. And
// setting `innerHTML` (or any other way of building markup) is not possible on it, so a script that put what a device
// sent on the page as markup would fail.

import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { ORIGIN, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, sendAs, type Who } from "./__fixtures__/identity-world";
import { API_APPROVE, API_DENY, API_PENDING, PAGE_PATH } from "./__fixtures__/approve-answers";

let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
});

/** One element of the page: what the script reads and writes on it, and nothing else. */
class Element {
  textContent = "";
  className = "";
  disabled = false;
  readonly attributes: Record<string, string> = {};
  readonly children: Element[] = [];
  private readonly listeners: Array<() => void> = [];
  constructor(readonly id: string, public hidden: boolean) {}
  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.listeners.push(listener);
  }
  click(): void {
    // A browser does not click a disabled button.
    if (!this.disabled) for (const listener of this.listeners) listener();
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  appendChild(child: Element): Element {
    this.children.push(child);
    return child;
  }
  set innerHTML(_markup: string) {
    throw new Error("the page built markup from text");
  }
  set outerHTML(_markup: string) {
    throw new Error("the page built markup from text");
  }
}

/** Every part of the page the script reads or writes. */
const IDS = [
  "title", "line", "ask", "question", "hint", "code", "actions", "allow", "deny", "alert",
  "result", "said", "quiet", "mark-allowed", "mark-denied", "mark-expired", "mark-used",
] as const;
type Id = (typeof IDS)[number];
const MARKS = ["mark-allowed", "mark-denied", "mark-expired", "mark-used"] as const;

/** A request the page made of Nexus. */
interface Call { method: string; path: string; code: string | null; body: unknown }

interface OpenPage {
  el: Record<Id, Element>;
  calls: Call[];
  /** The HTML the Worker served. */
  html: string;
  /** While true, the page cannot reach Nexus: its calls fail the way a dropped connection does. */
  unreachable: { now: boolean };
  /** Waits until the page has finished what it was doing: it is not busy asking Nexus. */
  settled: () => Promise<void>;
}

/** The text of a page or a file the Worker serves to the owner. */
async function served(path: string): Promise<string> {
  const answer = await sendAs("GET", path, owner);
  expect(answer.status, `${path} is served to the owner (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

/** Whether the served HTML has an element with this id, and whether it starts hidden. Null when there is none. */
function startsHidden(html: string, id: string): boolean | null {
  const tag = new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(html)?.[0];
  return tag === undefined ? null : /\shidden(?=[\s>=/])/i.test(tag);
}

/** Opens the page at this address (path and query), the way the owner's browser does, and runs its script. Nexus can be out of reach from the start. */
async function open(address: string, startUnreachable = false): Promise<OpenPage> {
  const html = await served(address);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]).filter((src) => src.endsWith("approve.js"));
  expect(scripts, "the page loads its own script").toHaveLength(1);
  const script = await served(new URL(scripts[0], `${ORIGIN}${PAGE_PATH}`).pathname);

  const elements = new Map<string, Element>();
  const el = {} as OpenPage["el"];
  for (const id of IDS) {
    const hidden = startsHidden(html, id);
    expect(hidden, `the page has an element with the id ${id}`).not.toBeNull();
    elements.set(id, (el[id] = new Element(id, hidden === true)));
  }

  const calls: Call[] = [];
  const unreachable = { now: startUnreachable };
  let busy = 0;
  const query = new URL(address, ORIGIN).search;
  const pageFetch = async (path: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
    busy += 1;
    try {
      if (unreachable.now) throw new TypeError("Failed to fetch");
      const url = new URL(path, ORIGIN);
      calls.push({
        method: options.method, path: url.pathname, code: url.searchParams.get("code"),
        body: options.body === undefined ? null : JSON.parse(options.body),
      });
      // The browser sends the owner's own cookie with a call to the page's own address.
      const headers = { ...options.headers, cookie: (owner as { cookie: string }).cookie };
      return await worker.fetch(new Request(url, { method: options.method, headers, body: options.body }), appEnv());
    } finally {
      busy -= 1;
    }
  };

  runInNewContext(script, {
    window: { location: { search: query } },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new Element("", false),
    },
    URLSearchParams,
    // The page's own clock, read when it works out the minutes a code has left: the test's, which may be set.
    Date,
    Math,
    fetch: pageFetch,
  });

  const settled = async () => {
    // The page's own promises run between these turns of the loop: a few quiet turns in a row mean it has nothing left to do.
    let quiet = 0;
    for (let turn = 0; turn < 500 && quiet < 5; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      quiet = busy === 0 ? quiet + 1 : 0;
    }
    expect(busy, "the page's call to Nexus finished").toBe(0);
  };
  await settled();
  return { el, calls, html, unreachable, settled };
}

/** A device asks to sign in, and the page for its link is opened. */
async function openLinkFor(label: string) {
  const started = bodyOf(await device().start("agents", label));
  const link = new URL(started.link);
  const page = await open(link.pathname + link.search);
  return { ...started, page };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const questionShown = (page: OpenPage) => !page.el.ask.hidden;
const buttonsShown = (page: OpenPage) => !page.el.ask.hidden && !page.el.actions.hidden;
/** The marks that are showing: a card shows exactly one. */
const marksShown = (page: OpenPage) => MARKS.filter((id) => !page.el[id].hidden).map((id) => id.replace("mark-", ""));
/** The code's boxes as the page draws them: a list of groups, each a list of one character per box. */
const codeBoxes = (page: OpenPage) => page.el.code.children.map((group) => group.children.map((box) => box.textContent));

const TEN_MINUTES = 10 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("board 1: the page the owner is shown for a waiting sign-in", () => {
  it("asks Nexus what is being asked, says it as a question, and offers Allow and Deny without answering anything", async () => {
    const { code, page } = await openLinkFor("lab-m");

    expect(page.calls, "the page asks once, for what is being asked").toEqual([
      { method: "GET", path: API_PENDING, code, body: null },
    ]);
    expect(page.el.title.textContent).toBe("new device");
    expect(page.el.line.textContent).toBe("A device wants to sign in.");
    expect(page.el.question.textContent).toBe("Allow lab-m to use Nexus as agents?");
    expect(questionShown(page)).toBe(true);
    expect(buttonsShown(page)).toBe(true);
    expect(page.el.allow.disabled).toBe(false);
    expect(page.el.deny.disabled).toBe(false);
    expect(page.el.result.hidden, "no answer yet").toBe(true);
    expect(page.el.alert.hidden, "nothing is wrong").toBe(true);
    expect(posts(page.calls), "nothing is answered until the owner taps").toEqual([]);
  });

  it("shows the device's own code, one read-only box per character in groups of four, with the whole code as its label", async () => {
    const { code, page } = await openLinkFor("lab-code");
    const characters = code.replace("-", "").split("");
    expect(characters, "the code Nexus made, without its dash").toHaveLength(8);

    expect(codeBoxes(page)).toEqual([characters.slice(0, 4), characters.slice(4)]);
    expect(page.el.code.attributes["aria-label"], "read out as one string").toBe(`Device code ${characters.join("")}`);
    expect(page.el.code.children.map((group) => group.className)).toEqual(["code__group code__group--of-4", "code__group code__group--of-4"]);
    // Nothing is typed on this screen: there are two buttons, Allow and Deny, and no field or other button.
    expect(page.html.match(/<button\b/gi)).toHaveLength(2);
    expect(page.html).not.toMatch(/<(?:input|textarea|select)\b/i);
  });

  it("takes the ten-minute line from the expiry Nexus sent, not from a number of its own", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const started = bodyOf(await device().start("agents", "lab-minutes"));
    const link = new URL(started.link);
    const hintAt = async (later: number) => {
      vi.setSystemTime(now + later);
      return (await open(link.pathname + link.search)).el.hint.textContent;
    };

    expect(await hintAt(0)).toBe("Only allow it if you just asked for it. The code stops working in 10 minutes.");
    expect(await hintAt(3 * 60 * 1000 + 20 * 1000)).toBe("Only allow it if you just asked for it. The code stops working in 7 minutes.");
    expect(await hintAt(TEN_MINUTES - 30 * 1000)).toBe("Only allow it if you just asked for it. The code stops working in 1 minute.");
  });

  it("starts with every part but the slab out of sight, so nothing untrue is shown before Nexus has answered", async () => {
    const html = await served(PAGE_PATH);
    for (const id of ["ask", "result", "alert", ...MARKS]) expect(startsHidden(html, id), `${id} starts hidden`).toBe(true);
    expect(html).toMatch(/Checking the code/);
  });

  it("stops both buttons at the first tap, so nothing is sent twice", async () => {
    const { code, page } = await openLinkFor("lab-twice");
    page.el.allow.click();
    expect(page.el.allow.disabled).toBe(true);
    expect(page.el.deny.disabled).toBe(true);
    page.el.allow.click();
    page.el.deny.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_APPROVE, code: null, body: { code } }]);
  });
});

describe("board 2: Allow", () => {
  it("sends the code to approve, says the device can use Nexus, takes the question away, and the device is then handed its token", async () => {
    const { code, secret, page } = await openLinkFor("lab-allow");
    page.el.allow.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_APPROVE, code: null, body: { code } }]);
    expect(page.el.title.textContent).toBe("allowed");
    expect(page.el.line.textContent).toBe("The device is in.");
    expect(page.el.said.textContent).toBe("lab-allow can use Nexus now.");
    expect(page.el.quiet.textContent).toBe("You can close this page. The device does the rest.");
    expect(page.el.quiet.hidden).toBe(false);
    expect(marksShown(page), "the teal tick").toEqual(["allowed"]);
    expect(page.el.result.hidden).toBe(false);
    expect(questionShown(page), "there is nothing left to tap").toBe(false);
    expect(page.el.alert.hidden).toBe(true);

    // It was really allowed, in Nexus: the device's next poll is handed its token.
    expect(bodyOf(await device().poll(secret))).toMatchObject({ status: "approved", identity: "agents", label: "lab-allow" });
  });
});

describe("board 3: Deny", () => {
  it("sends the code to deny, says the device was not given a token, takes the question away, and the device is refused", async () => {
    const { code, secret, page } = await openLinkFor("lab-deny");
    page.el.deny.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_DENY, code: null, body: { code } }]);
    expect(page.el.title.textContent).toBe("denied");
    expect(page.el.line.textContent).toBe("Nothing was shared.");
    expect(page.el.said.textContent).toBe("lab-deny was not given a token.");
    expect(page.el.quiet.textContent).toBe("Changed your mind? Start again on the device.");
    expect(marksShown(page), "the grey cross, not a red one").toEqual(["denied"]);
    expect(questionShown(page)).toBe(false);
    expect(page.el.alert.hidden).toBe(true);

    expectRefusal(await device().poll(secret), 403, "the poll after the owner denied it");
  });
});

describe("board 4: a code that ran out", () => {
  it("says so with no buttons and sends nothing, for a code that was never answered and is past its ten minutes", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const started = bodyOf(await device().start("agents", "lab-ran-out"));
    const link = new URL(started.link);

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    const page = await open(link.pathname + link.search);

    expect(page.el.title.textContent).toBe("code ran out");
    expect(page.el.line.textContent).toBe("Ten minutes is up.");
    expect(page.el.said.textContent).toBe("That code has run out.");
    expect(page.el.quiet.textContent).toBe("Ask for a new one on the device.");
    expect(marksShown(page), "the red clock").toEqual(["expired"]);
    expect(questionShown(page)).toBe(false);
    expect(posts(page.calls)).toEqual([]);
  });

  it("is shown in place of the question when the ten minutes run out while the page is open and the owner taps Allow", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { secret, page } = await openLinkFor("lab-ran-out-open");
    expect(questionShown(page)).toBe(true);

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    page.el.allow.click();
    await page.settled();

    expect(page.el.title.textContent).toBe("code ran out");
    expect(marksShown(page)).toEqual(["expired"]);
    expect(page.el.said.textContent).not.toMatch(/can use Nexus/);
    expect(questionShown(page), "a finished code cannot be tapped again").toBe(false);
    expectRefusal(await device().poll(secret), 410, "the device is not given a token");
  });
});

describe("board 5: a code that was used", () => {
  it("says so with no buttons and sends nothing, for a code that was allowed already", async () => {
    const used = bodyOf(await device().start("agents", "lab-used"));
    bodyOf(await device(owner).approve(used.code));
    const link = new URL(used.link);
    const page = await open(link.pathname + link.search);

    expect(page.el.title.textContent).toBe("code used");
    expect(page.el.line.textContent).toBe("One answer per code.");
    expect(page.el.said.textContent).toBe("That code was already used.");
    expect(page.el.quiet.textContent).toBe("A code works once. Ask for a new one on the device.");
    expect(marksShown(page), "the red cross").toEqual(["used"]);
    expect(questionShown(page)).toBe(false);
    expect(page.el.alert.hidden).toBe(true);
    expect(posts(page.calls)).toEqual([]);
  });

  it("says so for a code that was denied, and for one that was answered and has since run out", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const denied = bodyOf(await device().start("agents", "lab-used-denied"));
    bodyOf(await device(owner).deny(denied.code));
    const allowed = bodyOf(await device().start("agents", "lab-used-then-late"));
    bodyOf(await device(owner).approve(allowed.code));

    for (const [wait, started] of [[0, denied], [TEN_MINUTES + 1000, allowed]] as const) {
      vi.setSystemTime(now + wait);
      const link = new URL(started.link);
      const page = await open(link.pathname + link.search);
      expect(page.el.title.textContent).toBe("code used");
      expect(marksShown(page)).toEqual(["used"]);
    }
  });

  it("says so for a code Nexus has no sign-in for, which is a code long past answering", async () => {
    const page = await open(`${PAGE_PATH}?code=${encodeURIComponent("ZZZZ-ZZZZ")}`);
    expect(page.el.title.textContent).toBe("code used");
    expect(marksShown(page)).toEqual(["used"]);
    expect(questionShown(page)).toBe(false);
  });

  it("is shown, and does not claim it was allowed, when the code is used somewhere else before the owner taps", async () => {
    // The page is open and waiting; the code is answered somewhere else before the owner taps.
    const { code, page } = await openLinkFor("lab-too-slow");
    bodyOf(await device(owner).deny(code));
    page.el.allow.click();
    await page.settled();

    expect(page.el.title.textContent).toBe("code used");
    expect(page.el.said.textContent).toBe("That code was already used.");
    expect(page.el.said.textContent).not.toMatch(/can use Nexus/);
    expect(questionShown(page), "a finished code cannot be tapped again").toBe(false);
  });
});

describe("what the boards do not draw: no code, and Nexus out of reach", () => {
  it("says what is missing, offers no Allow, and sends nothing when the address has no code", async () => {
    const page = await open(PAGE_PATH);
    expect(page.el.result.hidden).toBe(false);
    expect(page.el.said.textContent).toMatch(/no code/i);
    expect(questionShown(page)).toBe(false);
    expect(page.calls, "nothing is sent to Nexus").toEqual([]);
  });

  it("says Nexus could not be reached, with no Allow, when the first call fails", async () => {
    const started = bodyOf(await device().start("agents", "lab-offline-first"));
    const link = new URL(started.link);
    const page = await open(link.pathname + link.search, true);
    expect(page.el.said.textContent).toMatch(/could not be reached/);
    expect(questionShown(page)).toBe(false);
  });

  it("keeps the question and gives the buttons back when an answer cannot be sent, saying why beside them", async () => {
    const { page } = await openLinkFor("lab-offline-answer");
    page.unreachable.now = true;
    page.el.allow.click();
    await page.settled();

    expect(page.el.alert.hidden).toBe(false);
    expect(page.el.alert.textContent).toMatch(/could not be reached/);
    expect(questionShown(page), "the owner can try again").toBe(true);
    expect(page.el.allow.disabled).toBe(false);
    expect(page.el.deny.disabled).toBe(false);
    expect(page.el.result.hidden, "nothing was answered").toBe(true);

    page.unreachable.now = false;
    page.el.allow.click();
    await page.settled();
    expect(page.el.title.textContent).toBe("allowed");
    expect(page.el.alert.hidden).toBe(true);
  });
});

describe("what a device sent", () => {
  it("is shown as plain text: a label that is markup is the words on the question and on the answer, and no markup is built from it", async () => {
    const label = '<img src=x onerror="window.__nexusPage=1">';
    const { page } = await openLinkFor(label);
    // The stand-in throws if the script sets innerHTML or outerHTML, which would have stopped the question being shown.
    expect(page.el.question.textContent).toBe(`Allow ${label} to use Nexus as agents?`);
    expect(questionShown(page)).toBe(true);

    page.el.allow.click();
    await page.settled();
    expect(page.el.said.textContent).toBe(`${label} can use Nexus now.`);
  });

  it("is shown as plain text on a denied card too", async () => {
    const label = "<b>lab</b> & <script>alert(1)</script>";
    const { page } = await openLinkFor(label);
    page.el.deny.click();
    await page.settled();
    expect(page.el.said.textContent).toBe(`${label} was not given a token.`);
  });
});
