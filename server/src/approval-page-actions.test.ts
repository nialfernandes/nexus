// What the approval page DOES, run for real: the page's own HTML and its own script (approve.js), as the Worker serves
// them, with Nexus answering through the real Worker and the real database. The owner opens the link a device was handed,
// sees "Allow <label> to use Nexus as <identity>?" with the device's code, and taps Allow or Deny. The states are the
// owner secret (for a browser that is not signed in), the question, allowed, denied, the code ran out and the code was used.
//
// THIS IS NOT A BROWSER TEST. It ports the old site's browser test of this page (the question and its two buttons,
// what each tap sends, a refusal in plain words, a label that is markup) without Playwright, because this package
// has no Playwright and `npm test` is vitest only. The page's script is run in a node:vm context against a small
// stand-in for the page (document.getElementById, createElement, textContent, hidden, disabled, click, a form's submit and a
// field's value), and the page's calls go to the real Worker, with the owner's cookie or, for a browser that has none, with
// what the page itself sends, so no answer in this file is written by hand. What the stand-in does not do,
// and so what is NOT checked anywhere in this package: how the page is laid out and whether it fits a phone or a desktop,
// the size of its buttons, the typefaces, and its colours (approval-page.test.ts reads the stylesheets, but nothing
// draws them, so how it looks is looked at by eye when it changes).
//
// The stand-in is kept honest in two ways. An element exists only if the served HTML has an element with that id, and it
// starts hidden only if the HTML says `hidden`, so a page whose HTML lost an id or its `hidden` fails here. And
// setting `innerHTML` (or any other way of building markup) is not possible on it, so a script that put what a device
// sent on the page as markup would fail. So is keeping anything in the browser: the page is given no local or session
// storage and a `document.cookie` that refuses to be written, so a script that stored the owner secret would fail.

import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { ORIGIN, OWNER_SECRET, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { OWNER_SECRET_HEADER, device, sendAs, type Who } from "./__fixtures__/identity-world";
import { API_APPROVE, API_DENY, API_PENDING, GONE_EXPIRED, PAGE_PATH } from "./__fixtures__/approve-answers";

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
  /** What a field holds. */
  value = "";
  focused = false;
  private readonly listeners: Array<(event: { preventDefault: () => void }) => void> = [];
  constructor(readonly id: string, public hidden: boolean) {}
  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void): void {
    if (type === "click" || type === "submit") this.listeners.push(listener);
  }
  click(): void {
    // A browser does not click a disabled button.
    if (!this.disabled) for (const listener of this.listeners) listener({ preventDefault: () => {} });
  }
  /** A form sent, by its button or by Enter in its field. Returns whether the page took over from the browser's own send. */
  submit(): boolean {
    let taken = false;
    for (const listener of this.listeners) listener({ preventDefault: () => { taken = true; } });
    return taken;
  }
  focus(): void {
    this.focused = true;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
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
  "title", "line", "owner", "owner-form", "secret", "owner-alert", "owner-go", "ask", "question", "hint", "code", "actions", "allow", "deny", "alert",
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
  /** What the page sent in the owner-secret header with each call, in order: the secret, or null for a call that sent none. */
  sentSecrets: Array<string | null>;
  /** While true, the page cannot reach Nexus: its calls fail the way a dropped connection does. */
  unreachable: { now: boolean };
  /** Waits until the page has finished what it was doing: it is not busy asking Nexus. */
  settled: () => Promise<void>;
}

/** The text of a page or a file the Worker serves: to the owner, or to a browser that is not signed in. */
async function served(path: string, who: Who = owner): Promise<string> {
  const answer = await sendAs("GET", path, who);
  expect(answer.status, `${path} is served (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

/** Whether the served HTML has an element with this id, and whether it starts hidden. Null when there is none. */
function startsHidden(html: string, id: string): boolean | null {
  const tag = new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(html)?.[0];
  return tag === undefined ? null : /\shidden(?=[\s>=/])/i.test(tag);
}

/** How the browser the page is opened in is set up. */
interface Browser {
  /** True (the default) for the owner's own browser, which holds the owner's cookie. False for a browser that is signed in as nobody. */
  cookie?: boolean;
  /** False for a page opened over plain http, where a browser does not call the page a secure context. True by default. */
  secure?: boolean;
}

/** Opens the page at this address (path and query), the way a browser does (the owner's by default), and runs its script. Nexus can be out of reach from the start. */
async function open(address: string, startUnreachable = false, browser: Browser = {}): Promise<OpenPage> {
  const { cookie = true, secure = true } = browser;
  const html = await served(address, cookie ? owner : null);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]).filter((src) => src.endsWith("approve.js"));
  expect(scripts, "the page loads its own script").toHaveLength(1);
  const script = await served(new URL(scripts[0], `${ORIGIN}${PAGE_PATH}`).pathname, cookie ? owner : null);

  const elements = new Map<string, Element>();
  const el = {} as OpenPage["el"];
  for (const id of IDS) {
    const hidden = startsHidden(html, id);
    expect(hidden, `the page has an element with the id ${id}`).not.toBeNull();
    elements.set(id, (el[id] = new Element(id, hidden === true)));
  }

  const calls: Call[] = [];
  const sentSecrets: Array<string | null> = [];
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
      sentSecrets.push(options.headers[OWNER_SECRET_HEADER] ?? null);
      // The owner's browser sends the owner's own cookie with a call to the page's own address. Another browser sends none.
      const headers = cookie ? { ...options.headers, cookie: (owner as { cookie: string }).cookie } : options.headers;
      return await worker.fetch(new Request(url, { method: options.method, headers, body: options.body }), appEnv());
    } finally {
      busy -= 1;
    }
  };

  const kept = () => { throw new Error("the page kept something in the browser"); };
  runInNewContext(script, {
    window: {
      location: { search: query },
      isSecureContext: secure,
      get localStorage() { return kept(); },
      get sessionStorage() { return kept(); },
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new Element("", false),
      get cookie() { return ""; },
      set cookie(_value: string) { kept(); },
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
  return { el, calls, sentSecrets, html, unreachable, settled };
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

describe("the question: the page the owner is shown for a waiting sign-in", () => {
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
    expect(page.el.owner.hidden, "the owner's browser is signed in already, so no secret is asked for").toBe(true);
    expect(page.sentSecrets, "and none is sent").toEqual([null]);
    expect(posts(page.calls), "nothing is answered until the owner taps").toEqual([]);
  });

  it("shows the device's own code, one read-only box per character in groups of four, with the whole code as its label", async () => {
    const { code, page } = await openLinkFor("lab-code");
    const characters = code.replace("-", "").split("");
    expect(characters, "the code Nexus made, without its dash").toHaveLength(8);

    expect(codeBoxes(page)).toEqual([characters.slice(0, 4), characters.slice(4)]);
    expect(page.el.code.attributes["aria-label"], "read out as one string").toBe(`Device code ${characters.join("")}`);
    expect(page.el.code.children.map((group: Element) => group.className)).toEqual(["code__group code__group--of-4", "code__group code__group--of-4"]);
    // Nothing is typed on the question: its card has the two buttons, Allow and Deny, and no field or other button. The only field on
    // the page is the owner secret's, and it is in the owner card.
    const questionCard = /<section\b[^>]*\bid="ask"[\s\S]*?<\/section>/i.exec(page.html)?.[0] ?? "";
    expect(questionCard.match(/<button\b/gi)).toHaveLength(2);
    expect(questionCard).not.toMatch(/<(?:input|textarea|select)\b/i);
    expect(page.html.match(/<(?:input|textarea|select)\b/gi)).toHaveLength(1);
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
    for (const id of ["ask", "owner", "owner-alert", "result", "alert", ...MARKS]) expect(startsHidden(html, id), `${id} starts hidden`).toBe(true);
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

describe("allowed: Allow", () => {
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

describe("denied: Deny", () => {
  it("sends the code to deny, says the device was not given a token, takes the question away, and the device is refused", async () => {
    const { code, secret, page } = await openLinkFor("lab-deny");
    page.el.deny.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_DENY, code: null, body: { code } }]);
    expect(page.el.title.textContent).toBe("denied");
    expect(page.el.line.textContent).toBe("Nothing was shared.");
    expect(page.el.said.textContent).toBe("lab-deny was not given a token.");
    expect(page.el.quiet.textContent).toBe("Changed your mind? Start again from the device.");
    expect(marksShown(page), "the grey cross, not a red one").toEqual(["denied"]);
    expect(questionShown(page)).toBe(false);
    expect(page.el.alert.hidden).toBe(true);

    expectRefusal(await device().poll(secret), 403, "the poll after the owner denied it");
  });
});

describe("code ran out: a code that ran out", () => {
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
    expect(page.el.said.textContent, "in Nexus's own words").toBe(GONE_EXPIRED.error);
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

describe("code used: a code that was used", () => {
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

describe("no code in the link, and Nexus out of reach", () => {
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

// A first device is set up with no Terminal: the browser the link is opened in holds no owner cookie, so the page asks for the
// owner secret itself, and sends it (in a header, over a secure connection only) with its calls until the code is answered.
describe("the owner secret: a browser that is not signed in as the owner", () => {
  const NOBODY: Browser = { cookie: false };

  /** A device asks to sign in as `label`, and its link is opened in a browser that holds no owner cookie. */
  async function openAsNobody(label: string, browser: Browser = NOBODY) {
    const started = bodyOf(await device().start("agents", label));
    const link = new URL(started.link);
    return { ...started, page: await open(link.pathname + link.search, false, browser) };
  }

  /** The owner types into the field and sends the form. */
  async function typeSecret(page: OpenPage, typed: string) {
    page.el.secret.value = typed;
    expect(page.el["owner-form"].submit(), "the page, not the browser, sends the form").toBe(true);
    await page.settled();
  }

  it("is the first thing shown, with no question and nothing sent but the one ask that Nexus turned away", async () => {
    const { code, page } = await openAsNobody("MacBook");

    expect(page.calls, "the page asked once, and Nexus said it does not know who is asking").toEqual([
      { method: "GET", path: API_PENDING, code, body: null },
    ]);
    expect(page.sentSecrets).toEqual([null]);
    expect(page.el.owner.hidden).toBe(false);
    expect(page.el.secret.focused, "the cursor is in the field").toBe(true);
    expect(page.el["owner-alert"].hidden, "no fault yet").toBe(true);
    expect(page.el.title.textContent).toBe("new device");
    expect(page.el.line.textContent).toBe("Only the owner can answer a device.");
    expect(questionShown(page), "nothing about the device is shown before the owner is known").toBe(false);
    expect(page.el.result.hidden).toBe(true);
    // One field, one button, and it is a password field the browser does not remember.
    expect(page.html).toMatch(/<input\b[^>]*\bid="secret"[^>]*\btype="password"/i);
    expect(page.html).toMatch(/<input\b[^>]*\bid="secret"[^>]*\bautocomplete="off"/i);
    expect(page.html).toMatch(/<button\b[^>]*\btype="submit"[^>]*\bid="owner-go"/i);
  });

  it("worked example: a device asks as MacBook, the right secret shows its question, Allow shows allowed, and the device's poll gets its token", async () => {
    const { code, secret, page } = await openAsNobody("MacBook");
    await typeSecret(page, OWNER_SECRET);

    expect(page.el.owner.hidden, "the secret step is done").toBe(true);
    expect(page.el.question.textContent).toBe("Allow MacBook to use Nexus as agents?");
    expect(buttonsShown(page)).toBe(true);
    expect(page.el.secret.value, "the field was emptied as the secret was sent").toBe("");
    expect(posts(page.calls), "nothing is answered by typing the secret").toEqual([]);
    expect(bodyOf(await device().poll(secret)), "still waiting").toMatchObject({ status: "pending" });

    page.el.allow.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_APPROVE, code: null, body: { code } }]);
    expect(page.sentSecrets, "the ask, the ask with the secret, and the allow with the secret").toEqual([null, OWNER_SECRET, OWNER_SECRET]);
    expect(page.el.title.textContent).toBe("allowed");
    expect(page.el.said.textContent).toBe("MacBook can use Nexus now.");
    expect(marksShown(page)).toEqual(["allowed"]);
    expect(questionShown(page)).toBe(false);
    expect(page.el.owner.hidden).toBe(true);
    expect(bodyOf(await device().poll(secret)), "the device is handed its token").toMatchObject({ status: "approved", identity: "agents", label: "MacBook" });
  });

  it("says a wrong secret is wrong and allows nothing: the field turns red, no question is shown, and the device is still waiting", async () => {
    const { secret, page } = await openAsNobody("lab-wrong-secret");
    await typeSecret(page, `${OWNER_SECRET}x`);

    expect(page.sentSecrets[1], "the page did send what was typed").toBe(`${OWNER_SECRET}x`);
    expect(page.el.owner.hidden).toBe(false);
    expect(page.el["owner-alert"].hidden).toBe(false);
    expect(page.el["owner-alert"].textContent).toBe("That is not the owner secret.");
    expect(page.el.secret.attributes["aria-invalid"]).toBe("true");
    expect(page.el.secret.value, "a wrong secret is not left in the field").toBe("");
    expect(questionShown(page)).toBe(false);
    expect(page.el.result.hidden).toBe(true);
    expect(page.el.question.textContent, "the device's label was not given away").toBe("");
    expect(posts(page.calls), "nothing was allowed or denied").toEqual([]);
    expect(bodyOf(await device().poll(secret)), "the device is still waiting").toMatchObject({ status: "pending" });
    expect(bodyOf(await device(owner).pending((await device(owner).waiting()).body.signins.find((s: { label: string }) => s.label === "lab-wrong-secret").code)), "the sign-in is untouched").toMatchObject({ label: "lab-wrong-secret" });

    // A second try with the right one goes through, and the fault is gone.
    await typeSecret(page, OWNER_SECRET);
    expect(questionShown(page)).toBe(true);
    expect(page.el["owner-alert"].hidden).toBe(true);
    expect(page.el.secret.attributes["aria-invalid"]).toBeUndefined();
  });

  it("sends nothing and says so when the field is empty or only spaces", async () => {
    const { page } = await openAsNobody("lab-empty-secret");
    const before = page.calls.length;
    await typeSecret(page, "   ");
    expect(page.calls).toHaveLength(before);
    expect(page.el["owner-alert"].textContent).toBe("Type the owner secret first.");
    expect(questionShown(page)).toBe(false);
  });

  it("takes the secret as typed with the spaces around it trimmed, as the Terminal does", async () => {
    const { page } = await openAsNobody("lab-spaces");
    await typeSecret(page, `  ${OWNER_SECRET} \n`);
    expect(page.sentSecrets[1]).toBe(OWNER_SECRET);
    expect(questionShown(page)).toBe(true);
  });

  it("shows denied for Deny, and the device is refused", async () => {
    const { secret, page } = await openAsNobody("lab-deny-by-secret");
    await typeSecret(page, OWNER_SECRET);
    page.el.deny.click();
    await page.settled();

    expect(page.el.title.textContent).toBe("denied");
    expect(page.el.said.textContent).toBe("lab-deny-by-secret was not given a token.");
    expect(marksShown(page)).toEqual(["denied"]);
    expect(page.sentSecrets.at(-1)).toBe(OWNER_SECRET);
    expectRefusal(await device().poll(secret), 403, "the poll after the owner denied it");
  });

  it("shows code ran out for a code past its ten minutes, once the owner is known", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { page } = await openAsNobody("lab-ran-out-by-secret");
    vi.setSystemTime(now + TEN_MINUTES + 1000);
    await typeSecret(page, OWNER_SECRET);

    expect(page.el.title.textContent).toBe("code ran out");
    expect(page.el.said.textContent).toBe(GONE_EXPIRED.error);
    expect(marksShown(page)).toEqual(["expired"]);
    expect(page.el.owner.hidden).toBe(true);
    expect(questionShown(page)).toBe(false);
  });

  it("shows code used for a code that was answered already, once the owner is known", async () => {
    const used = bodyOf(await device().start("agents", "lab-used-by-secret"));
    bodyOf(await device(owner).approve(used.code));
    const link = new URL(used.link);
    const page = await open(link.pathname + link.search, false, NOBODY);
    expect(page.el.owner.hidden, "the secret is asked for first: Nexus tells nobody about a code").toBe(false);
    await typeSecret(page, OWNER_SECRET);

    expect(page.el.title.textContent).toBe("code used");
    expect(page.el.said.textContent).toBe("That code was already used.");
    expect(marksShown(page)).toEqual(["used"]);
    expect(page.el.owner.hidden).toBe(true);
    expect(posts(page.calls)).toEqual([]);
  });

  it("asks again, saying the secret is wrong, when Allow is refused because the sign-in no longer works", async () => {
    const { page } = await openAsNobody("lab-secret-changed");
    await typeSecret(page, OWNER_SECRET);
    expect(questionShown(page)).toBe(true);

    // The Worker's secret is changed under the open page: the next call is turned away.
    const env = appEnv();
    const was = env.NEXUS_OWNER_SECRET;
    env.NEXUS_OWNER_SECRET = "a-new-owner-secret-set-after-the-page-opened".padEnd(64, "n");
    try {
      page.el.allow.click();
      await page.settled();
    } finally {
      env.NEXUS_OWNER_SECRET = was;
    }
    expect(page.el.owner.hidden).toBe(false);
    expect(page.el["owner-alert"].textContent).toBe("That is not the owner secret.");
    expect(page.el.title.textContent, "nothing was allowed").toBe("new device");
    expect(page.el.result.hidden).toBe(true);
  });

  it("will not send the secret from a page that is not a secure context: the field is off, nothing is sent, and it says why", async () => {
    const { page } = await openAsNobody("lab-plain-http", { cookie: false, secure: false });
    expect(page.el.secret.disabled).toBe(true);
    expect(page.el["owner-go"].disabled).toBe(true);
    expect(page.el["owner-alert"].textContent).toBe("Open this page over a secure connection (https) to type the owner secret.");
    page.el.secret.value = OWNER_SECRET;
    page.el["owner-form"].submit();
    await page.settled();
    expect(page.sentSecrets, "no secret left this page").toEqual([null]);
    expect(page.calls).toHaveLength(1);
    expect(questionShown(page)).toBe(false);
  });

  it("keeps the secret nowhere in the browser: no storage, no cookie (the page is given none it can write), and no word of it on the page", async () => {
    // The stand-in throws if the script touches localStorage, sessionStorage or writes document.cookie, so every test above
    // already fails on a page that did. This one reads what is left on the page after the secret has been used.
    const { page } = await openAsNobody("lab-kept-nowhere");
    await typeSecret(page, OWNER_SECRET);
    page.el.allow.click();
    await page.settled();
    for (const element of Object.values(page.el) as Element[]) {
      expect(element.value, `${element.id} holds no secret`).not.toContain(OWNER_SECRET);
      expect(element.textContent, `${element.id} shows no secret`).not.toContain(OWNER_SECRET);
      expect(Object.values(element.attributes).join(" "), `${element.id} has no secret in an attribute`).not.toContain(OWNER_SECRET);
    }
    expect(page.html, "and the page's own text never held it").not.toContain(OWNER_SECRET);
  });

  it("is not the way into the owner's page for a stranger: a stranger's cookie is no different from none", async () => {
    // A browser holding a cookie that is not the owner's is asked for the secret like any other.
    const started = bodyOf(await device().start("agents", "lab-stranger-cookie"));
    const answer = await sendAs("GET", `${API_PENDING}?code=${encodeURIComponent(started.code)}`, { cookie: "nexus_owner=" + "b".repeat(64) });
    expectRefusal(answer, 401, "pending for a stranger");
    expect(answer.text).not.toContain("lab-stranger-cookie");
  });
});
