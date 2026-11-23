// A stand-in for the browser the Nexus page (public/nexus/nexus.js) runs in, so the page's own script can be run in plain Node against
// the fake Nexus (nexus-page-answers.ts). The page's HTML and script are the ones the Worker serves; nothing of either is copied here.
//
// WHAT IS NOT CHECKED HERE: how the page is laid out, its colours and typefaces, and the real clipboard. Those are looked at in a real
// browser by e2e/nexus.spec.ts.
//
// The stand-in is kept honest as the approval page's own is (approval-page-actions.test.ts). An element exists only if the served HTML has
// an element with that id, and it starts hidden only if the HTML says `hidden`, so a page whose HTML lost an id or its `hidden` fails.
// Setting `innerHTML` (or any other way of building markup) throws, so a script that put what Nexus sent on the page as markup fails.
// The page is given no local or session storage and a `document.cookie` that refuses to be written, so a script that kept the owner
// secret anywhere would fail. And time is the test's: the page's timers (the Undo wait, the list of devices waiting asked for again)
// run only when `advance` says so.

import { runInNewContext } from "node:vm";
import { expect } from "vitest";
import { ORIGIN } from "./nexus-world";
import { sendAs, type Who } from "./identity-world";
import { API, FAKE_OWNER_SECRET_HEADER, NEXUS_PAGE, type FakeNexus } from "./nexus-page-answers";

type Listener = (event: { preventDefault: () => void }) => void;

/** One element of the page: what the script reads and writes on it, and nothing else. */
export class Element {
  className = "";
  disabled = false;
  type = "";
  value = "";
  focused = false;
  readonly attributes: Record<string, string> = {};
  children: Element[] = [];
  private text = "";
  private readonly listeners: Record<string, Listener[]> = {};
  constructor(readonly id: string, public hidden: boolean, readonly tag = "div") {}

  /** What the element says: its own text, or the text of what is inside it. Setting it takes everything inside away, as a browser does. */
  get textContent(): string {
    return this.children.length > 0 ? this.children.map((child) => child.textContent).join(" ") : this.text;
  }
  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  /** A tap. A browser does not click a disabled button. */
  click(): void {
    if (!this.disabled) for (const listener of this.listeners.click ?? []) listener({ preventDefault: () => {} });
  }
  /** Typing into a field: it holds what was typed, and the page hears it as a browser's `input` event (and may take letters back out). */
  enter(text: string): void {
    this.value = text;
    for (const listener of this.listeners.input ?? []) listener({ preventDefault: () => {} });
  }
  /** A form sent, by its button or by Enter in its field. */
  submit(): void {
    for (const listener of this.listeners.submit ?? []) listener({ preventDefault: () => {} });
  }
  focus(): void { this.focused = true; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  appendChild(child: Element): Element {
    this.children.push(child);
    return child;
  }
  set innerHTML(_markup: string) { throw new Error("the page built markup from text"); }
  set outerHTML(_markup: string) { throw new Error("the page built markup from text"); }

  /** Every element inside this one, nearest first, this one included. */
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  /** The buttons inside this one, whose aria-label or text is exactly this. */
  button(name: string): Element {
    const found = this.all().filter((e) => e.tag === "button" && (e.attributes["aria-label"] ?? e.textContent) === name);
    expect(found.map((e) => e.attributes["aria-label"] ?? e.textContent), `one button called "${name}" in ${this.id || this.className}`).toHaveLength(1);
    return found[0]!;
  }
  /** The text of every element of this class inside this one. */
  textsOf(className: string): string[] {
    return this.all().filter((e) => e.className.split(" ").includes(className)).map((e) => e.textContent);
  }
}

/** Every part of the page the script reads. */
export const IDS = [
  "title", "where", "back", "slab-actions", "add-open", "apps", "ask", "line", "alert", "owner", "owner-form", "secret", "owner-alert", "owner-go",
  "signed-in", "waiting", "view-connected", "people", "nobody", "only-you", "add-first",
  "view-add", "add-card", "add-form", "agent-name", "agent-hint", "add-go", "add-alert", "command", "command-text", "copy", "waiting-for", "joined", "joined-title", "joined-words",
  "view-agent", "agent-card", "remove-agent", "view-settings", "sign-out", "undo", "tab-connected", "tab-settings",
] as const;
export type Id = (typeof IDS)[number];

/** A timer the page asked for. */
interface Timer { id: number; at: number; run: () => void; every: number | null }

export interface Browser {
  /** False for a page opened over plain http. True by default. */
  secure?: boolean;
  /** What the clipboard does with the text: kept in `copied`, or refused. Default: it takes it. */
  clipboard?: "takes" | "refuses" | "none";
}

export interface OpenNexusPage {
  el: Record<Id, Element>;
  html: string;
  /** What the clipboard was handed, in order. */
  copied: string[];
  /** Lets the page's time pass: its timers that fall due run, in order, and its calls finish. */
  advance: (ms: number) => Promise<void>;
  /** Waits until the page has finished what it was doing: no call to Nexus is out. */
  settled: () => Promise<void>;
  /** Types the owner secret and sends the form, as a person does. */
  signInWith: (secret: string) => Promise<void>;
}

/** The text of a page or a file the Worker serves, to nobody (the page is the same for everyone). */
async function served(path: string, who: Who = null): Promise<string> {
  const answer = await sendAs("GET", path, who);
  expect(answer.status, `${path} is served (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

/** Whether the served HTML has an element with this id, and whether it starts hidden. Null when there is none. */
function startsHidden(html: string, id: string): { hidden: boolean; tag: string } | null {
  const tag = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(html);
  return tag === null ? null : { hidden: /\shidden(?=[\s>=/])/i.test(tag[0]), tag: tag[1]!.toLowerCase() };
}

/** Opens the Nexus page the way a browser does and runs its script against the fake. The Worker must be set up (setUpNexus) to serve it. */
export async function openNexusPage(fake: FakeNexus, browser: Browser = {}): Promise<OpenNexusPage> {
  const { secure = true, clipboard = "takes" } = browser;
  const html = await served(NEXUS_PAGE);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]!).filter((src) => src.endsWith("nexus.js"));
  expect(scripts, "the page loads its own script").toHaveLength(1);
  const script = await served(new URL(scripts[0]!, `${ORIGIN}${NEXUS_PAGE}`).pathname);

  const el = {} as Record<Id, Element>;
  const byId = new Map<string, Element>();
  for (const id of IDS) {
    const found = startsHidden(html, id);
    expect(found, `the page has an element with the id ${id}`).not.toBeNull();
    byId.set(id, (el[id] = new Element(id, found!.hidden, found!.tag)));
  }

  let busy = 0;
  const pageFetch = async (path: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
    busy += 1;
    try {
      const url = new URL(path, ORIGIN);
      expect(url.pathname.startsWith(API), `${url.pathname} is under Nexus's API`).toBe(true);
      const route = url.pathname.slice(API.length) + url.search;
      const said = fake.answer(options.method, route, options.body === undefined ? null : JSON.parse(options.body), options.headers[FAKE_OWNER_SECRET_HEADER] ?? null);
      return new Response(JSON.stringify(said.json), { status: said.status, headers: { "content-type": "application/json" } });
    } finally {
      busy -= 1;
    }
  };

  // The page's time.
  let now = 0;
  let nextTimer = 1;
  let timers: Timer[] = [];
  const addTimer = (run: () => void, ms: number, every: number | null) => {
    timers.push({ id: nextTimer, at: now + ms, run, every });
    return nextTimer++;
  };

  const copied: string[] = [];
  const kept = () => { throw new Error("the page kept something in the browser"); };
  const navigator = clipboard === "none" ? undefined : {
    clipboard: {
      writeText: async (text: string) => {
        if (clipboard === "refuses") throw new Error("not allowed");
        copied.push(text);
      },
    },
  };
  runInNewContext(script, {
    window: {
      location: { origin: ORIGIN, search: "" },
      isSecureContext: secure,
      get localStorage() { return kept(); },
      get sessionStorage() { return kept(); },
    },
    document: {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: (tag: string) => new Element("", false, tag),
      get cookie() { return ""; },
      set cookie(_value: string) { kept(); },
    },
    navigator,
    Promise, JSON, Date, Math, Array, Object, Error,
    setTimeout: (run: () => void, ms: number) => addTimer(run, ms, null),
    setInterval: (run: () => void, ms: number) => addTimer(run, ms, ms),
    clearTimeout: (id: number) => { timers = timers.filter((t) => t.id !== id); },
    clearInterval: (id: number) => { timers = timers.filter((t) => t.id !== id); },
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

  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = due.at;
      if (due.every === null) timers = timers.filter((t) => t !== due);
      else due.at += due.every;
      due.run();
      await settled();
    }
    now = until;
  };

  const signInWith = async (secret: string) => {
    el.secret.value = secret;
    el["owner-form"].submit();
    await settled();
  };

  await settled();
  return { el, html, copied, advance, settled, signInWith };
}
