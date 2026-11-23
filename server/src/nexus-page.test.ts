// The Nexus page, at /nexus/: that the Worker serves it (to the owner, to nobody and to a stranger alike, with its two stylesheets, its
// script and the typefaces), that it takes every colour from the token variables, has no dark set, builds no markup from what Nexus
// sent and loads nothing from outside Nexus; what it DOES, run for real (its own script, as the Worker serves it, against the fake of
// Nexus in __fixtures__/nexus-page-answers.ts): who is connected, a device waiting, add an agent with its command, remove with Undo;
// and that the fake's answers are the real routes' answers wherever a real route exists. The page signed out is in
// nexus-page-signed-out.test.ts, and its refusals in nexus-page-refusals.test.ts. What it looks like in a browser, at a phone's width
// and a desktop's, is e2e/nexus.spec.ts (run with `npm run test:browser`).

import { beforeAll, describe, expect, it } from "vitest";
import { parseRules } from "./__fixtures__/css-rules";
import { ORIGIN, bodyOf, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { device, manage, sendAs, type Who } from "./__fixtures__/identity-world";
import { PENDING } from "./__fixtures__/approve-answers";
import { FakeNexus, NEXUS_PAGE, WORKED } from "./__fixtures__/nexus-page-answers";
import { openNexusPage } from "./__fixtures__/nexus-page-world";

let owner: Who;
let stranger: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
  stranger = { cookie: (await signInStranger()).cookie };
});

/** A long wait: past any Undo window. */
const LONG_WAIT = 60_000;
/** A short one: inside any Undo window. */
const A_MOMENT = 1000;

// ── the page is served ───────────────────────────────────────────────────────

/** What a page's markup points at or holds: stylesheets, scripts, inline style and style attributes. */
function partsOf(html: string) {
  const tags = (name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  return {
    stylesheets: tags("link").filter((t) => /rel\s*=\s*["']stylesheet["']/i.test(t)).map((t) => attr(t, "href")).filter((h): h is string => !!h),
    scripts: tags("script").map((t) => attr(t, "src")).filter((h): h is string => !!h),
    inlineStyles: [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!),
    styleAttributes: [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!),
    inlineScripts: [...html.matchAll(/<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!),
  };
}

/** Fetches a file the page links, as the owner, through the Worker. */
async function fetchLinked(href: string): Promise<string> {
  const url = new URL(href, `${ORIGIN}${NEXUS_PAGE}`);
  expect(url.origin, `${href} is on Nexus's own address`).toBe(ORIGIN);
  const answer = await sendAs("GET", url.pathname + url.search, owner);
  expect(answer.status, `${href} is served (${answer.text.slice(0, 80)})`).toBe(200);
  return answer.text;
}

// A colour written out where the theme should have supplied it: a hex, a colour function, or a colour's name.
const COLOUR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i;
const HEX = /#[0-9a-f]{3,8}\b/i;
const COLOUR_NAME = /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|maroon|lime|aqua|fuchsia|olive|brown|cyan|magenta)\b/i;
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|caret|accent/i;

/** Every declaration in some CSS whose value writes a colour out. Token declarations (`--x:`) are the theme itself and are skipped. */
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

describe("the Nexus page is served at /nexus/", () => {
  it("is a page: HTML that fits a phone, with stylesheets and a script", async () => {
    const html = (await sendAs("GET", NEXUS_PAGE, owner)).text;
    expect(html).toMatch(/<html\b/i);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*width=device-width/i);
    const parts = partsOf(html);
    expect(parts.stylesheets, "the approval page's stylesheet (its tokens) and the page's own").toEqual(["/nexus/approve.css", "/nexus/nexus.css"]);
    expect(parts.scripts).toEqual(["/nexus/nexus.js"]);
  });

  it("is the same page for the owner, for nobody and for a stranger: it holds nothing private, and the owner signs in on it", async () => {
    const asOwner = await sendAs("GET", NEXUS_PAGE, owner);
    expect(asOwner.status).toBe(200);
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      const answer = await sendAs("GET", NEXUS_PAGE, who);
      expect(answer.status, `the page for ${what}`).toBe(200);
      expect(answer.text, `the page for ${what} is the page the owner gets`).toBe(asOwner.text);
    }
  });

  it("is not kept by a browser, and its files are served to anyone", async () => {
    const res = await (await import("./plugs/cloudflare/worker")).default.fetch(new Request(`${ORIGIN}${NEXUS_PAGE}`), (await import("./__fixtures__/nexus-world")).appEnv());
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const file of ["/nexus/nexus.css", "/nexus/nexus.js", "/nexus/approve.css"]) {
      expect((await sendAs("GET", file, null)).status, `${file} signed out`).toBe(200);
    }
  });

  it("is served at /nexus/ only: the file behind it is not an address of its own", async () => {
    for (const path of ["/nexus/index.html", "/nexus/index", "/nexus/nexus", "/nexus/fonts/"]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(404);
    }
  });

  it("writes no colour of its own in its stylesheet or its markup, reads the token variables, and has no dark set", async () => {
    const html = (await sendAs("GET", NEXUS_PAGE, owner)).text;
    const parts = partsOf(html);
    const sheet = await fetchLinked("/nexus/nexus.css");
    expect(rawColours(sheet), "colours written out instead of taken from the token variables").toEqual([]);
    for (const attribute of parts.styleAttributes) expect(rawColours(`x { ${attribute} }`)).toEqual([]);
    expect(parts.inlineStyles, "no inline style").toEqual([]);
    expect(sheet.match(/var\(\s*--[a-z0-9-]+/gi)?.length ?? 0, "it reads the variables").toBeGreaterThan(0);
    expect(sheet, "a dark set").not.toMatch(/prefers-color-scheme/i);
    expect(html, "the page asks for the light scheme alone").toMatch(/<meta name="color-scheme" content="light"/);
    // Every variable it reads is one the approval page's stylesheet declares (it is loaded first), so none is missing.
    const declared = new Set((await fetchLinked("/nexus/approve.css")).match(/--[a-z0-9-]+(?=\s*:)/gi));
    const read = new Set([...sheet.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]));
    expect([...read].filter((name) => !declared.has(name!)), "variables read but declared nowhere").toEqual([]);
  });

  it("never builds markup from what Nexus sent, keeps nothing in the browser, and loads nothing from outside Nexus", async () => {
    const html = (await sendAs("GET", NEXUS_PAGE, owner)).text;
    const script = await fetchLinked("/nexus/nexus.js");
    expect(script, "markup built from text").not.toMatch(/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/);
    expect(script, "a place the secret could be kept").not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    for (const text of [html, script, await fetchLinked("/nexus/nexus.css")]) {
      const outside = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => !/^https?:\/\/www\.w3\.org\b/.test(u));
      expect(outside, "addresses outside Nexus").toEqual([]);
    }
  });
});

// ── what the page does ───────────────────────────────────────────────────────

/** The days and times the worked example writes, in the form the page shows ("Sat 12 Sep · 12:00"), whatever the machine's time zone. */
const WHEN = /^(?:Added|Last used) (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) · \d\d:\d\d$/;

describe("the Nexus page, signed in as the owner (the owner's cookie)", () => {
  it("lists the owner first, then each agent, each with its devices: label, added, last used", async () => {
    const page = await openNexusPage(new FakeNexus({ knownOwner: true }));

    expect(page.el.owner.hidden, "no secret is asked for").toBe(true);
    expect(page.el["signed-in"].hidden).toBe(false);
    expect(page.el.people.textsOf("person__name")).toEqual([WORKED.owner, WORKED.agent]);
    expect(page.el.people.textsOf("tag"), "what each one is").toEqual(["owner", "agent"]);
    expect(page.el.people.textsOf("device__label")).toEqual([WORKED.ownerDevice.label, WORKED.agentDevice.label]);
    const whens = page.el.people.textsOf("device__when");
    expect(whens).toHaveLength(4);
    for (const text of whens.filter((w) => !w.endsWith("never"))) expect(text, "the time in the Sat 12 Sep · 12:00 form").toMatch(WHEN);
    expect(whens[3], "the agent's device has not been used").toBe("Last used never");
    expect(page.el.nobody.hidden).toBe(true);
  });

  it("puts the owner first even when Nexus lists it later, and shows an owner with no devices as having none", async () => {
    const fake = new FakeNexus({ knownOwner: true, waiting: [] });
    fake.identities.reverse();
    fake.identities[0]!.devices = [];
    const page = await openNexusPage(fake);
    expect(page.el.people.textsOf("person__name")).toEqual([WORKED.owner, WORKED.agent]);
    expect(page.el.people.textsOf("card__quiet"), "the agent with no devices says so").toEqual(["No devices."]);
  });

  it("shows a device waiting as a strip with its name, who it asks to be and the code it shows, and Allow and Deny are one tap each", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);

    expect(page.el.waiting.hidden).toBe(false);
    expect(page.el.waiting.textsOf("strip__words")).toEqual(["iPhone wants to sign in as nial."]);
    expect(page.el.waiting.textsOf("strip__code"), "the code on the device's own screen, to compare").toEqual([PENDING.deviceCode]);
    expect(page.el.waiting.button("Allow iPhone").disabled).toBe(false);
    expect(page.el.waiting.button("Deny iPhone").disabled).toBe(false);
    expect(fake.calls.filter((c) => c.method === "POST"), "nothing is answered until the owner taps").toEqual([]);
  });

  it("shows the sign-in code for a device that sent no key, which is the one code on its screen", async () => {
    const fake = new FakeNexus({ knownOwner: true, waiting: [{ ...WORKED.waiting, deviceKey: null, deviceCode: null }] });
    const page = await openNexusPage(fake);
    expect(page.el.waiting.textsOf("strip__code")).toEqual([WORKED.waiting.code]);
  });

  it("Allow sends the code to device/approve once, takes the strip away, and the device is then listed under the one it signed in as", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);
    const allow = page.el.waiting.button("Allow iPhone");
    allow.click();
    expect(allow.disabled, "a second tap does nothing").toBe(true);
    allow.click();
    await page.settled();

    expect(fake.callsTo("device/approve").map((c) => c.body)).toEqual([{ code: WORKED.waiting.code }]);
    expect(page.el.waiting.children).toEqual([]);
    expect(page.el.waiting.hidden).toBe(true);
    expect(page.el.line.textContent).toBe("iPhone can use Nexus now.");
    expect(page.el.people.textsOf("device__label"), "iPhone is under nial now").toEqual([WORKED.ownerDevice.label, "iPhone", WORKED.agentDevice.label]);
  });

  it("Deny sends the code to device/deny and the device is not listed", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);
    page.el.waiting.button("Deny iPhone").click();
    await page.settled();

    expect(fake.callsTo("device/deny").map((c) => c.body)).toEqual([{ code: WORKED.waiting.code }]);
    expect(fake.callsTo("device/approve")).toEqual([]);
    expect(page.el.line.textContent).toBe("iPhone was not given a token.");
    expect(page.el.people.textsOf("device__label")).toEqual([WORKED.ownerDevice.label, WORKED.agentDevice.label]);
  });

  it("asks for the devices waiting again every few seconds, so one that starts to sign in appears without a reload", async () => {
    const fake = new FakeNexus({ knownOwner: true, waiting: [] });
    const page = await openNexusPage(fake);
    expect(page.el.waiting.hidden, "none waiting").toBe(true);

    fake.waiting.push({ ...WORKED.waiting, label: "Pixel", code: "PXL7-7LXP", expiresAt: PENDING.expiresAt });
    await page.advance(10_000);
    expect(page.el.waiting.textsOf("strip__words")).toEqual(["Pixel wants to sign in as nial."]);
  });

  it("adds an agent: sends the name as an agent, lists it with no devices, and shows the one command to run on it, with Copy", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);
    expect(page.el.command.hidden, "no command before an agent is added").toBe(true);
    page.el["agent-name"].value = `  ${WORKED.newAgent} `;
    page.el["add-form"].submit();
    await page.settled();

    expect(fake.callsTo("identity", "POST").map((c) => c.body)).toEqual([{ name: WORKED.newAgent, kind: "agent" }]);
    expect(page.el.people.textsOf("person__name")).toEqual([WORKED.owner, WORKED.agent, WORKED.newAgent]);
    const added = page.el.people.children[2]!;
    expect(added.textsOf("card__quiet"), "lab-m has no devices").toEqual(["No devices."]);
    expect(added.textsOf("device__label")).toEqual([]);
    expect(page.el["agent-name"].value, "the box is empty for the next one").toBe("");
    expect(page.el["add-alert"].hidden).toBe(true);
    expect(page.el.command.hidden).toBe(false);
    // The command the agent runs is the one nexus-agent takes (packages/agent/src/cli/main.ts: sign-in --identity <name> --label <label>,
    // reading NEXUS_ADDRESS from labels.ts), with the address this page was opened at.
    expect(page.el["command-text"].textContent).toBe(`NEXUS_ADDRESS=${ORIGIN}/nexus/api nexus-agent sign-in --identity lab-m --label lab-m`);
  });

  it("Copy hands the command to the clipboard and says so for a moment; and where the browser will not copy, says to select it", async () => {
    const page = await openNexusPage(new FakeNexus({ knownOwner: true }));
    page.el["agent-name"].value = WORKED.newAgent;
    page.el["add-form"].submit();
    await page.settled();
    page.el.copy.click();
    await page.settled();
    expect(page.copied).toEqual([page.el["command-text"].textContent]);
    expect(page.el.copy.textContent).toBe("Copied");
    await page.advance(5000);
    expect(page.el.copy.textContent).toBe("Copy");

    const refused = await openNexusPage(new FakeNexus({ knownOwner: true }), { clipboard: "refuses" });
    refused.el["agent-name"].value = WORKED.newAgent;
    refused.el["add-form"].submit();
    await refused.settled();
    refused.el.copy.click();
    await refused.settled();
    expect(refused.el["add-alert"].textContent).toBe("That did not copy. Select the command and copy it.");
    expect(refused.el.copy.textContent, "it did not say it copied").toBe("Copy");
  });

  it("says the key is handed over in Obsidian on a device that holds it, never on this page, and the page has no place to type or show a key", async () => {
    const page = await openNexusPage(new FakeNexus({ knownOwner: true }));
    expect(page.html).toMatch(/The key is handed over in Obsidian, on a device that holds it, never on this page\./);
    const fields = page.html.match(/<(?:input|textarea|select)\b[^>]*>/gi) ?? [];
    expect(fields.map((f) => /\bid="([^"]+)"/.exec(f)?.[1]), "the owner secret and the agent's name are the only things typed here").toEqual(["secret", "agent-name"]);
  });

  it("removes an agent: the row goes at once with Undo and nothing is sent; Undo puts it back and still nothing is sent; removing it again sends identity/remove once the window has passed", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);

    page.el.people.button(`Remove ${WORKED.agent}`).click();
    expect(page.el.people.textsOf("person__name"), "the row is gone at once").toEqual([WORKED.owner]);
    expect(page.el.people.textsOf("device__label"), "and so are its devices").toEqual([WORKED.ownerDevice.label]);
    expect(page.el.undo.hidden).toBe(false);
    expect(page.el.undo.textsOf("undo__words")).toEqual(["scribe removed."]);
    await page.advance(A_MOMENT);
    expect(fake.callsTo("identity/remove"), "inside the window, nothing is sent").toEqual([]);

    page.el.undo.button(`Undo ${WORKED.agent} removed.`).click();
    expect(page.el.people.textsOf("person__name"), "Undo puts it back").toEqual([WORKED.owner, WORKED.agent]);
    expect(page.el.people.textsOf("device__label")).toEqual([WORKED.ownerDevice.label, WORKED.agentDevice.label]);
    expect(page.el.undo.hidden).toBe(true);
    await page.advance(LONG_WAIT);
    expect(fake.callsTo("identity/remove"), "Undo really cancelled it: no call, however long it waits").toEqual([]);
    expect(fake.identities.map((i) => i.name), "Nexus still has it").toEqual([WORKED.owner, WORKED.agent]);

    page.el.people.button(`Remove ${WORKED.agent}`).click();
    await page.advance(A_MOMENT);
    expect(fake.callsTo("identity/remove")).toEqual([]);
    await page.advance(LONG_WAIT);
    expect(fake.callsTo("identity/remove", "POST").map((c) => c.body), "sent once, when the window had passed").toEqual([{ name: WORKED.agent }]);
    expect(page.el.people.textsOf("person__name")).toEqual([WORKED.owner]);
    expect(page.el.undo.hidden, "nothing left to undo").toBe(true);
    expect(fake.identities.map((i) => i.name)).toEqual([WORKED.owner]);
  });

  it("removes a device the same way, by token/revoke with its id, and only the device: its agent stays", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await openNexusPage(fake);

    page.el.people.button(`Remove ${WORKED.agentDevice.label}`).click();
    expect(page.el.people.textsOf("person__name"), "the agent stays").toEqual([WORKED.owner, WORKED.agent]);
    expect(page.el.people.textsOf("device__label")).toEqual([WORKED.ownerDevice.label]);
    page.el.undo.button(`Undo ${WORKED.agentDevice.label} removed.`).click();
    await page.advance(LONG_WAIT);
    expect(fake.callsTo("token/revoke"), "undone, so never sent").toEqual([]);

    page.el.people.button(`Remove ${WORKED.agentDevice.label}`).click();
    await page.advance(LONG_WAIT);
    expect(fake.callsTo("token/revoke", "POST").map((c) => c.body)).toEqual([{ id: WORKED.agentDevice.id }]);
    expect(page.el.people.textsOf("device__label")).toEqual([WORKED.ownerDevice.label]);
    expect(page.el.people.textsOf("card__quiet"), "the agent now has no devices").toEqual(["No devices."]);
  });

  it("offers Remove on an agent and on a device, and not on the owner", async () => {
    const page = await openNexusPage(new FakeNexus({ knownOwner: true }));
    const labels = page.el.people.all().filter((e) => e.tag === "button").map((e) => e.attributes["aria-label"]);
    expect(labels).toEqual([`Remove ${WORKED.ownerDevice.label}`, `Remove ${WORKED.agent}`, `Remove ${WORKED.agentDevice.label}`]);
  });

  it("puts what Nexus sent on the page as text: a label that is markup stays text", async () => {
    const markup = `<img src=x onerror="alert(1)">`;
    const fake = new FakeNexus({ knownOwner: true, waiting: [{ ...WORKED.waiting, label: markup }] });
    fake.identities[0]!.devices[0]!.label = markup;
    const page = await openNexusPage(fake);
    expect(page.el.waiting.textsOf("strip__words")).toEqual([`${markup} wants to sign in as nial.`]);
    expect(page.el.people.textsOf("device__label")[0]).toBe(markup);
  });
});

// ── the fake is the real routes' answers ─────────────────────────────────────

describe("the fake of Nexus answers as the real routes do, wherever a real route exists", () => {
  /** The kind of value under each key. */
  const kinds = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v]));

  /** Every key the fake has, the real answer has too, with the same kind of value. */
  function expectSameShape(real: unknown, fake: unknown, what: string) {
    const realKinds = kinds(real as Record<string, unknown>);
    for (const [key, kind] of Object.entries(kinds(fake as Record<string, unknown>))) expect(realKinds[key], `${what}: ${key}`).toBe(kind);
  }

  it("for the sign-ins waiting, what one asks, allowing and denying", async () => {
    const fake = new FakeNexus({ knownOwner: true, waiting: [{ ...WORKED.waiting, identity: "agents", deviceKey: PENDING.deviceKey, deviceCode: PENDING.deviceCode }] });
    const started = bodyOf(await device().start("agents", "iPhone", PENDING.deviceKey));

    const realWaiting = bodyOf(await device(owner).waiting());
    const fakeWaiting = fake.answer("GET", "device/waiting", null, null).json as { signins: unknown[] };
    expectSameShape(realWaiting, fakeWaiting, "waiting");
    expectSameShape(realWaiting.signins.find((s: { code: string }) => s.code === started.code), fakeWaiting.signins[0], "a waiting sign-in");

    const realPending = bodyOf(await device(owner).pending(started.code));
    const fakePending = fake.answer("GET", `device/pending?code=${WORKED.waiting.code}`, null, null).json;
    expectSameShape(realPending, fakePending, "pending");
    expect(realPending.deviceCode, "the fake's code is the one the server works out for that key").toBe((fakePending as { deviceCode: string }).deviceCode);

    const approved = bodyOf(await device(owner).approve(started.code));
    expectSameShape(approved, fake.answer("POST", "device/approve", { code: WORKED.waiting.code }, null).json, "approved");
    const other = bodyOf(await device().start("agents", "Pixel"));
    const denied = bodyOf(await device(owner).deny(other.code));
    const second = new FakeNexus({ knownOwner: true });
    expectSameShape(denied, second.answer("POST", "device/deny", { code: WORKED.waiting.code }, null).json, "denied");
  });

  it("for adding an agent, its refusals, and revoking a device", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const created = bodyOf(await manage(owner).createIdentity("lab-shape", "agent"));
    expectSameShape(created, fake.answer("POST", "identity", { name: "lab-shape", kind: "agent" }, null).json, "identity");

    const real409 = await manage(owner).createIdentity("lab-shape", "agent");
    const fake409 = fake.answer("POST", "identity", { name: "lab-shape", kind: "agent" }, null);
    expect(real409.status).toBe(fake409.status);
    expect(real409.body, "a name taken, in the real words").toEqual(fake409.json);

    const real400 = await manage(owner).createIdentity("Lab M", "agent");
    const fake400 = fake.answer("POST", "identity", { name: "Lab M", kind: "agent" }, null);
    expect(real400.status).toBe(fake400.status);
    expect(real400.body, "a name that is not allowed, in the real words").toEqual(fake400.json);

    const started = bodyOf(await device().start("lab-shape", "lab-shape-box"));
    bodyOf(await device(owner).approve(started.code));
    const tokens = bodyOf(await manage(owner).tokens()).tokens as Array<{ id: string; label: string }>;
    const made = tokens.find((t) => t.label === "lab-shape-box")!;
    const revoked = bodyOf(await manage(owner).revoke(made.id));
    expectSameShape(revoked, fake.answer("POST", "token/revoke", { id: WORKED.ownerDevice.id }, null).json, "revoked");
    const real404 = await manage(owner).revoke("nothing");
    const fake404 = fake.answer("POST", "token/revoke", { id: "nothing" }, null);
    expect(real404.status).toBe(fake404.status);
    expect(real404.body).toEqual(fake404.json);
  });

  it("for a sign-in nobody is signed in for: the real words of a 401", async () => {
    const real = await device(null).waiting();
    const fake = new FakeNexus().answer("GET", "device/waiting", null, null);
    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
    expect(real.body).toEqual(fake.json);
  });
});
