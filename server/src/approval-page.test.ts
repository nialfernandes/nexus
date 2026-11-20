// The approval page, read from what the Worker serves: that the link a device is handed opens the page for anyone who has it
// (the owner signs in on it, so it cannot wait for a sign-in), that the page's stylesheets take every colour from the page's own token variables, that its script
// never builds markup from what a device sent, and that the answers a browser check would give the page
// (__fixtures__/approve-answers.ts) are the answers the real routes give. What the page does when the owner taps is
// run against the real Worker in approval-page-actions.test.ts. What the page looks like on a screen (its layout, its
// size on a phone, its colours) is checked by the browser spec in approve.spec.ts, not here: this package's own tests have no browser.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRules } from "./__fixtures__/css-rules";
import { ORIGIN, bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { device, sendAs, type Who } from "./__fixtures__/identity-world";
import { API_APPROVE, API_DENY, API_PENDING, APPROVED, DENIED, GONE, GONE_EXPIRED, NOT_FOUND, PAGE_PATH, PENDING } from "./__fixtures__/approve-answers";

let owner: Who;
let stranger: Who;

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
  stranger = { cookie: (await signInStranger()).cookie };
});

/** Everything the page's markup points at or holds: stylesheets, scripts, inline style, and style attributes. */
function partsOf(html: string) {
  const tags = (name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  return {
    stylesheets: tags("link").filter((t) => /rel\s*=\s*["']stylesheet["']/i.test(t)).map((t) => attr(t, "href")).filter((h): h is string => !!h),
    scripts: tags("script").map((t) => attr(t, "src")).filter((h): h is string => !!h),
    inlineStyles: [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
    styleAttributes: [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]),
    inlineScripts: [...html.matchAll(/<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]),
  };
}

/** Fetches a file the page links, as the owner, through the Worker. */
async function fetchLinked(href: string): Promise<string> {
  const url = new URL(href, `${ORIGIN}${PAGE_PATH}`);
  expect(url.origin, `${href} is on Nexus's own address`).toBe(ORIGIN);
  const answer = await sendAs("GET", url.pathname + url.search, owner);
  expect(answer.status, `${href} is served (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

async function openPage(): Promise<string> {
  const started = bodyOf(await device().start("agents", "lab-m"));
  const link = new URL(started.link);
  const answer = await sendAs("GET", link.pathname + link.search, owner);
  expect(answer.status, `the link a device is handed opens the page for the owner (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

// A colour written out where the theme should have supplied it: a hex, a colour function, or a colour's name.
const COLOUR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i;
const HEX = /#[0-9a-f]{3,8}\b/i;
const COLOUR_NAME = /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|maroon|lime|aqua|fuchsia|olive|brown|cyan|magenta)\b/i;
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|caret|accent/i;

/** Every declaration in some CSS whose value writes a colour out, with its rule. Token declarations (`--x:`) are the theme itself and are skipped. */
function rawColours(css: string): string[] {
  const found: string[] = [];
  for (const rule of parseRules(css)) {
    for (const [property, value] of rule.declarations) {
      if (property.startsWith("--")) continue;
      if (HEX.test(value) || COLOUR_FUNCTION.test(value) || (COLOUR_PROPERTY.test(property) && COLOUR_NAME.test(value))) {
        found.push(`${rule.selector} { ${property}: ${value} }`);
      }
    }
  }
  return found;
}

describe("the link a device is handed opens the approval page", () => {
  it("is a page: HTML that fits a phone, with a stylesheet and a script of its own", async () => {
    const html = await openPage();
    expect(html).toMatch(/<html\b/i);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*width=device-width/i);
    const parts = partsOf(html);
    expect(parts.stylesheets.length, "a stylesheet").toBeGreaterThan(0);
    expect(parts.scripts.length, "a script").toBeGreaterThan(0);
  });

  it("is the same page for the owner, for nobody and for someone who is not the owner: it holds nothing private, and the owner signs in on it", async () => {
    const asOwner = await sendAs("GET", `${PAGE_PATH}?code=ABCD`, owner);
    expect(asOwner.status, "the page for the owner").toBe(200);
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      const answer = await sendAs("GET", `${PAGE_PATH}?code=ABCD`, who);
      expect(answer.status, `the page for ${what}`).toBe(200);
      expect(answer.text, `the page for ${what} is the page the owner gets`).toBe(asOwner.text);
    }
  });

  it("holds nothing of the sign-in it is opened for: the code in the link is not in the page, so the page asks Nexus, which asks for the owner", async () => {
    const started = bodyOf(await device().start("agents", "lab-secret-label"));
    const answer = await sendAs("GET", new URL(started.link).pathname + new URL(started.link).search, null);
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(started.code);
    expect(answer.text).not.toContain("lab-secret-label");
    expect(answer.text).not.toContain(started.secret);
  });
});

describe("the page's typefaces", () => {
  /** Every address a stylesheet's @font-face rules load a font from. */
  const fontAddresses = (css: string) => [...css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)].map((m) => m[1]);

  it("are the files its stylesheet names, served beside it to the owner and to anyone else who opens the page", async () => {
    const parts = partsOf(await openPage());
    const addresses = new Set<string>();
    for (const href of parts.stylesheets) {
      const sheet = await fetchLinked(href);
      for (const address of fontAddresses(sheet)) addresses.add(new URL(address, new URL(href, `${ORIGIN}${PAGE_PATH}`)).pathname);
    }
    expect([...addresses].sort(), "the three typefaces the page is set in").toEqual([
      "/nexus/fonts/instrument-sans-var.woff2", "/nexus/fonts/jetbrains-mono-var.woff2", "/nexus/fonts/unbounded-var.woff2",
    ]);
    for (const address of addresses) {
      const asOwner = await sendAs("GET", address, owner);
      expect(asOwner.status, `${address} for the owner`).toBe(200);
      expect(asOwner.text.length, `${address} is a font file`).toBeGreaterThan(1000);
      expect((await sendAs("GET", address, null)).status, `${address} signed out`).toBe(200);
      expect((await sendAs("GET", address, stranger)).status, `${address} for a stranger`).toBe(200);
    }
  });
});

describe("the page takes every colour from its own token variables", () => {
  it("writes no colour of its own, in its stylesheets, its inline style or any style attribute", async () => {
    const parts = partsOf(await openPage());
    const sheets = [...parts.inlineStyles];
    for (const href of parts.stylesheets) sheets.push(await fetchLinked(href));
    expect(sheets.length).toBeGreaterThan(0);

    const raw = sheets.flatMap(rawColours);
    for (const attribute of parts.styleAttributes) raw.push(...rawColours(`x { ${attribute} }`));
    expect(raw, "colours written out instead of taken from the token variables").toEqual([]);
  });

  it("has no dark set: the boards are drawn light only, so no stylesheet has a prefers-color-scheme block and the page asks for the light scheme alone", async () => {
    const html = await openPage();
    const parts = partsOf(html);
    expect(parts.stylesheets.length).toBeGreaterThan(0);
    for (const href of parts.stylesheets) {
      const sheet = await fetchLinked(href);
      expect(sheet, `${href} has a dark set`).not.toMatch(/prefers-color-scheme/i);
      expect(sheet, `${href} asks the browser for a dark scheme`).not.toMatch(/color-scheme\s*:[^;]*dark/i);
      expect(sheet, "the one scheme it asks for is light").toMatch(/color-scheme\s*:\s*light\s*;/i);
    }
    for (const css of parts.inlineStyles) expect(css).not.toMatch(/prefers-color-scheme/i);
    expect(html, "the page's own meta tag").not.toMatch(/<meta\s+name="color-scheme"[^>]*dark/i);
  });

  it("reaches the token variables at all: its stylesheets read variables", async () => {
    const parts = partsOf(await openPage());
    let reads = 0;
    for (const href of parts.stylesheets) reads += (await fetchLinked(href)).match(/var\(\s*--[a-z0-9-]+/gi)?.length ?? 0;
    for (const css of parts.inlineStyles) reads += css.match(/var\(\s*--[a-z0-9-]+/gi)?.length ?? 0;
    expect(reads).toBeGreaterThan(0);
  });
});

describe("the page's own code", () => {
  it("never builds markup from what a device sent, and loads nothing from outside Nexus", async () => {
    const html = await openPage();
    const parts = partsOf(html);
    const scripts = [...parts.inlineScripts];
    for (const src of parts.scripts) scripts.push(await fetchLinked(src));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script, "markup built from text").not.toMatch(/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/);
    }

    const everything = [html, ...scripts];
    for (const href of parts.stylesheets) everything.push(await fetchLinked(href));
    for (const text of everything) {
      const outside = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => !/^https?:\/\/www\.w3\.org\b/.test(u));
      expect(outside, "addresses outside Nexus").toEqual([]);
    }
  });

  it("calls Nexus's device routes: the address, and the words pending, approve and deny, appear in its code", async () => {
    const parts = partsOf(await openPage());
    const scripts = [...parts.inlineScripts];
    for (const src of parts.scripts) scripts.push(await fetchLinked(src));
    const code = scripts.join("\n");
    // The routes may be joined from pieces (an address and a name), so the pieces are what is looked for.
    expect(code, "the address of Nexus's device routes").toContain(API_PENDING.slice(0, API_PENDING.indexOf("device/") + "device".length));
    for (const [route, word] of [[API_PENDING, "pending"], [API_APPROVE, "approve"], [API_DENY, "deny"]] as const) {
      expect(route.endsWith(`device/${word}`)).toBe(true);
      expect(code, `the page calls device/${word}`).toContain(word);
    }
  });
});

describe("the answers the browser checks use are the real answers", () => {
  /** The kind of value under each key. */
  const kinds = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v]));

  /** Every key the fixture has, the real answer has too, with the same kind of value. */
  function expectSameShape(real: Record<string, unknown>, fixture: Record<string, unknown>, what: string) {
    const realKinds = kinds(real);
    for (const [key, kind] of Object.entries(kinds(fixture))) {
      expect(realKinds[key], `${what}: ${key}`).toBe(kind);
    }
  }

  it("for a sign-in that is waiting, allowed and denied", async () => {
    const waiting = bodyOf(await device().start("agents", "lab-m"));
    expectSameShape(bodyOf(await device(owner).pending(waiting.code)), PENDING, "pending");
    const approved = bodyOf(await device(owner).approve(waiting.code));
    expectSameShape(approved, APPROVED, "approved");
    expect(approved.result).toBe(APPROVED.result);

    const refused = bodyOf(await device().start("agents", "lab-m"));
    const denied = bodyOf(await device(owner).deny(refused.code));
    expectSameShape(denied, DENIED, "denied");
    expect(denied.result).toBe(DENIED.result);
  });

  it("for a code that has been used and a code nobody was given: a plain error, with the status the page expects", async () => {
    const used = bodyOf(await device().start("agents", "lab-m"));
    bodyOf(await device(owner).approve(used.code));
    const gone = await device(owner).pending(used.code);
    expectRefusal(gone, 410, "a used code");
    expectSameShape(gone.body, GONE, "gone");
    expect(gone.body, "the page draws the used card from this reason").toEqual(GONE);
    const unknown = await device(owner).pending("NOSUCHCODE");
    expectRefusal(unknown, 404, "an unknown code");
    expectSameShape(unknown.body, NOT_FOUND, "not found");
  });

  it("for a code that ran out: the same words and status as a used one, with the reason the page draws its own card from", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const waiting = bodyOf(await device().start("agents", "lab-m"));
    vi.setSystemTime(waiting.expiresAt + 1000);
    const gone = await device(owner).pending(waiting.code);
    expectRefusal(gone, 410, "an expired code");
    expectSameShape(gone.body, GONE_EXPIRED, "expired");
    expect(gone.body).toEqual(GONE_EXPIRED);
  });
});
