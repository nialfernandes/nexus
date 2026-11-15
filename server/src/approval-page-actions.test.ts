// What the approval page DOES, run for real: the page's own HTML and its own script (approve.js), as the Worker serves
// them to the owner, with Nexus answering through the real Worker and the real database. The owner opens the link a
// device was handed, sees "Allow <label> to use Nexus as <identity>?", and taps Allow or Deny.
//
// THIS IS NOT A BROWSER TEST. It ports the old site's browser test of this page (the question and its two buttons,
// what each tap sends, a refusal in plain words, a label that is markup) without Playwright, because this package
// has no Playwright and `npm test` is vitest only. The page's script is run in a node:vm context against a small
// stand-in for the page (document.getElementById, textContent, hidden, disabled, click), and the page's calls go to
// the real Worker as the owner, so no answer in this file is written by hand. What the stand-in does not do, and so
// what is NOT checked anywhere in this package: how the page is laid out and whether it fits a phone or a desktop,
// the size of its buttons, and its colours in the light and dark looks (approval-page.test.ts reads the stylesheets,
// but nothing draws them).
//
// The stand-in is kept honest in two ways. An element exists only if the served HTML has an element with that id, and it
// starts hidden only if the HTML says `hidden`, so a page whose HTML lost an id or its `hidden` fails here. And
// setting `innerHTML` (or any other way of building markup) is not possible on it, so a script that put what a device
// sent on the page as markup would fail.

import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { ORIGIN, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, sendAs, type Who } from "./__fixtures__/identity-world";
import { API_APPROVE, API_DENY, API_PENDING, GONE, NOT_FOUND, PAGE_PATH } from "./__fixtures__/approve-answers";

let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
});

/** One element of the page: what the script reads and writes on it, and nothing else. */
class Element {
  textContent = "";
  disabled = false;
  private readonly listeners: Array<() => void> = [];
  constructor(readonly id: string, public hidden: boolean) {}
  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.listeners.push(listener);
  }
  click(): void {
    // A browser does not click a disabled button.
    if (!this.disabled) for (const listener of this.listeners) listener();
  }
  set innerHTML(_markup: string) {
    throw new Error("the page built markup from text");
  }
  set outerHTML(_markup: string) {
    throw new Error("the page built markup from text");
  }
}

/** A request the page made of Nexus. */
interface Call { method: string; path: string; code: string | null; body: unknown }

interface OpenPage {
  el: Record<"question" | "hint" | "actions" | "allow" | "deny" | "status" | "alert", Element>;
  calls: Call[];
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

/** Opens the page at this address (path and query), the way the owner's browser does, and runs its script. */
async function open(address: string): Promise<OpenPage> {
  const html = await served(address);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]).filter((src) => src.endsWith("approve.js"));
  expect(scripts, "the page loads its own script").toHaveLength(1);
  const script = await served(new URL(scripts[0], `${ORIGIN}${PAGE_PATH}`).pathname);

  const elements = new Map<string, Element>();
  const el = {} as OpenPage["el"];
  for (const id of ["question", "hint", "actions", "allow", "deny", "status", "alert"] as const) {
    const hidden = startsHidden(html, id);
    expect(hidden, `the page has an element with the id ${id}`).not.toBeNull();
    elements.set(id, (el[id] = new Element(id, hidden === true)));
  }

  const calls: Call[] = [];
  let busy = 0;
  const query = new URL(address, ORIGIN).search;
  const pageFetch = async (path: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
    busy += 1;
    try {
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
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    URLSearchParams,
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
  return { el, calls, settled };
}

/** A device asks to sign in, and the page for its link is opened. */
async function openLinkFor(label: string) {
  const started = bodyOf(await device().start("agents", label));
  const link = new URL(started.link);
  const page = await open(link.pathname + link.search);
  return { ...started, page };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const buttonsShown = (page: OpenPage) => !page.el.actions.hidden;

describe("the page the owner is shown for a waiting sign-in", () => {
  it("asks Nexus what is being asked, says it as a question, and offers Allow and Deny without answering anything", async () => {
    const { code, page } = await openLinkFor("lab-m");

    expect(page.calls, "the page asks once, for what is being asked").toEqual([
      { method: "GET", path: API_PENDING, code, body: null },
    ]);
    expect(page.el.question.textContent).toBe("Allow lab-m to use Nexus as agents?");
    expect(page.el.question.hidden).toBe(false);
    expect(buttonsShown(page)).toBe(true);
    expect(page.el.allow.disabled).toBe(false);
    expect(page.el.deny.disabled).toBe(false);
    expect(page.el.alert.hidden, "nothing is wrong").toBe(true);
    expect(posts(page.calls), "nothing is answered until the owner taps").toEqual([]);
  });

  it("starts with the question, the buttons and the messages out of sight, so nothing untrue is shown before Nexus has answered", async () => {
    const html = await served(PAGE_PATH);
    for (const id of ["question", "actions", "status", "alert"]) expect(startsHidden(html, id), `${id} starts hidden`).toBe(true);
  });
});

describe("Allow", () => {
  it("sends the code to approve, says it was allowed, takes the buttons away, and the device is then handed its token", async () => {
    const { code, secret, page } = await openLinkFor("lab-allow");
    page.el.allow.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_APPROVE, code: null, body: { code } }]);
    expect(page.el.status.hidden).toBe(false);
    expect(page.el.status.textContent).toMatch(/^Allowed\./);
    expect(page.el.status.textContent).toContain("lab-allow as agents");
    expect(buttonsShown(page)).toBe(false);
    expect(page.el.question.hidden).toBe(true);
    expect(page.el.alert.hidden).toBe(true);

    // It was really allowed, in Nexus: the device's next poll is handed its token.
    expect(bodyOf(await device().poll(secret))).toMatchObject({ status: "approved", identity: "agents", label: "lab-allow" });
  });
});

describe("Deny", () => {
  it("sends the code to deny, says it was denied, takes the buttons away, and the device is refused", async () => {
    const { code, secret, page } = await openLinkFor("lab-deny");
    page.el.deny.click();
    await page.settled();

    expect(posts(page.calls)).toEqual([{ method: "POST", path: API_DENY, code: null, body: { code } }]);
    expect(page.el.status.textContent).toMatch(/^Denied\./);
    expect(buttonsShown(page)).toBe(false);
    expect(page.el.alert.hidden).toBe(true);

    expectRefusal(await device().poll(secret), 403, "the poll after the owner denied it");
  });
});

describe("a code that cannot be answered", () => {
  it("says so in Nexus's own words, with no buttons, for a code that was used already", async () => {
    const used = bodyOf(await device().start("agents", "lab-used"));
    bodyOf(await device(owner).approve(used.code));
    const link = new URL(used.link);
    const page = await open(link.pathname + link.search);

    expect(page.el.alert.hidden).toBe(false);
    expect(page.el.alert.textContent).toBe(GONE.error);
    expect(buttonsShown(page)).toBe(false);
    expect(page.el.question.hidden).toBe(true);
    expect(posts(page.calls)).toEqual([]);
  });

  it("says so in Nexus's own words, with no buttons, for a code nobody was given", async () => {
    const page = await open(`${PAGE_PATH}?code=${encodeURIComponent("ZZZZ-ZZZZ")}`);
    expect(page.el.alert.textContent).toBe(NOT_FOUND.error);
    expect(buttonsShown(page)).toBe(false);
  });

  it("tells the owner when the answer to Allow is refused, and does not claim it was allowed", async () => {
    // The page is open and waiting; the code is used somewhere else before the owner taps.
    const { code, page } = await openLinkFor("lab-too-slow");
    bodyOf(await device(owner).deny(code));
    page.el.allow.click();
    await page.settled();

    expect(page.el.alert.hidden).toBe(false);
    expect(page.el.alert.textContent).toBe(GONE.error);
    expect(page.el.status.hidden, "the line that said it was sending is gone").toBe(true);
    expect(page.el.status.textContent).not.toMatch(/Allowed/);
    expect(buttonsShown(page), "a finished code cannot be tapped again").toBe(false);
  });

  it("says what is missing, offers no Allow, and sends nothing when the address has no code", async () => {
    const page = await open(PAGE_PATH);
    expect(page.el.alert.hidden).toBe(false);
    expect(page.el.alert.textContent).toMatch(/no code/i);
    expect(buttonsShown(page)).toBe(false);
    expect(page.calls, "nothing is sent to Nexus").toEqual([]);
  });
});

describe("what a device sent", () => {
  it("is shown as plain text: a label that is markup is the words on the question, and no markup is built from it", async () => {
    const label = '<img src=x onerror="window.__nexusPage=1">';
    const { page } = await openLinkFor(label);
    // The stand-in throws if the script sets innerHTML or outerHTML, which would have stopped the question being shown.
    expect(page.el.question.textContent).toBe(`Allow ${label} to use Nexus as agents?`);
    expect(page.el.question.hidden).toBe(false);
  });
});
