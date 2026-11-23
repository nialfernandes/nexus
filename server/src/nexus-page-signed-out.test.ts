// The Nexus page for a browser that is not signed in as the owner: it asks for the owner secret and shows nothing else. The page's own
// HTML and script, as the Worker serves them, are run against the fake Nexus (__fixtures__/nexus-page-answers.ts) with no cookie, so
// every call Nexus is asked for is a 401. What a browser draws (layout, colours) is looked at in e2e/nexus.spec.ts and e2e/nexus-boards.spec.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { setUpNexus } from "./__fixtures__/nexus-world";
import { sendAs } from "./__fixtures__/identity-world";
import { FAKE_OWNER_SECRET, FAKE_OWNER_SECRET_HEADER, FakeNexus, NEXUS_PAGE, WORKED } from "./__fixtures__/nexus-page-answers";
import { IDS, openNexusPage, type OpenNexusPage } from "./__fixtures__/nexus-page-world";

beforeAll(async () => {
  await setUpNexus();
});

/** Every word on the page, in every part of it. */
const everythingSaid = (page: OpenNexusPage) => IDS.map((id) => page.el[id].textContent).join(" | ");

/** The names and labels of the worked example's world: none of them may be on a page for someone Nexus does not know. */
const NAMES_IN_THE_WORLD = [WORKED.owner, WORKED.agent, WORKED.ownerDevice.label, WORKED.agentDevice.label, WORKED.waiting.label, WORKED.waiting.code, WORKED.waiting.deviceCode];

describe("the Nexus page, signed out", () => {
  it("starts with everything but the owner-secret card out of sight, so nothing is shown before Nexus has answered", async () => {
    const html = (await sendAs("GET", NEXUS_PAGE, null)).text;
    for (const id of ["owner", "signed-in", "slab-actions", "alert", "waiting", "undo", "command", "view-add", "view-agent", "view-settings"]) {
      expect(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*\\shidden(?=[\\s>=/])`, "i").test(html), `${id} starts hidden`).toBe(true);
    }
  });

  it("asks for the owner secret and shows nothing else", async () => {
    const fake = new FakeNexus();
    const page = await openNexusPage(fake);

    expect(page.el.owner.hidden, "the owner-secret card is shown").toBe(false);
    expect(page.el["signed-in"].hidden, "everything else is out of sight").toBe(true);
    expect(page.el.secret.focused, "the field is ready to type in").toBe(true);
    expect(page.el.line.textContent).toBe("Only the owner can see this.");
    expect(page.el["owner-alert"].hidden, "nothing is wrong yet: nobody has typed").toBe(true);
    // Nothing of Nexus's is on the page, hidden or not: not who is connected, not a device waiting.
    expect(page.el.people.children, "no one is listed").toEqual([]);
    expect(page.el.waiting.children, "no device is waiting").toEqual([]);
    expect(page.el.undo.children).toEqual([]);
    expect(page.el.command.hidden).toBe(true);
    expect(page.el["slab-actions"].hidden, "the bar's buttons (Add, the Ask sparkle) are out of sight too").toBe(true);
    expect(page.el.back.hidden).toBe(true);
    expect(page.el.title.textContent).toBe("connected");
    for (const name of NAMES_IN_THE_WORLD) expect(everythingSaid(page), `${name} is nowhere on the page`).not.toContain(name as string);
    // It asked once, who is connected, with no secret, and was refused: it did not go on to ask what is waiting.
    expect(fake.calls).toEqual([{ method: "GET", route: "identities", body: null, secret: null }]);
  });

  it("calls a wrong secret wrong, empties the field, and still shows nothing else", async () => {
    const fake = new FakeNexus();
    const page = await openNexusPage(fake);
    await page.signInWith("b".repeat(64));

    expect(page.el["owner-alert"].textContent).toBe("That is not the owner secret.");
    expect(page.el["owner-alert"].hidden).toBe(false);
    expect(page.el.secret.attributes["aria-invalid"]).toBe("true");
    expect(page.el.secret.value, "the field is emptied as the secret goes").toBe("");
    expect(page.el["signed-in"].hidden).toBe(true);
    expect(everythingSaid(page)).not.toContain(WORKED.owner);
    expect(fake.calls.map((c) => c.secret), "the wrong secret was sent in the owner-secret header, once").toEqual([null, "b".repeat(64)]);
  });

  it("shows the page for the right secret, and sends it with every call after, in the header and nowhere else", async () => {
    const fake = new FakeNexus();
    const page = await openNexusPage(fake);
    await page.signInWith(FAKE_OWNER_SECRET);

    expect(page.el.owner.hidden, "the field is gone").toBe(true);
    expect(page.el["signed-in"].hidden, "the page is shown").toBe(false);
    expect(page.el["slab-actions"].hidden, "with the bar's buttons").toBe(false);
    expect(page.el.people.textsOf("person__name"), "the owner is \"you\"").toEqual(["you", WORKED.agent]);
    expect(page.el.secret.value).toBe("");
    const withSecret = fake.calls.filter((c) => c.secret === FAKE_OWNER_SECRET).map((c) => c.route);
    expect(withSecret, "who is connected and who is waiting were asked for with the secret").toEqual(["identities", "device/waiting", "device/pending?code=" + encodeURIComponent(WORKED.waiting.code)]);
    expect(FAKE_OWNER_SECRET_HEADER).toBe("x-nexus-owner-secret");
    // Nexus later refusing the secret (it was changed): the page goes back to asking, with nothing of Nexus's left on it.
    fake.ownerSecret = "c".repeat(64);
    await page.advance(5000);
    expect(page.el.owner.hidden, "asked for the secret again").toBe(false);
    expect(page.el["signed-in"].hidden).toBe(true);
    expect(page.el["slab-actions"].hidden, "the bar's buttons go too").toBe(true);
    expect(page.el["owner-alert"].textContent).toBe("That is not the owner secret.");
    expect(page.el.people.children, "who was connected is taken off the page").toEqual([]);
    expect(everythingSaid(page)).not.toContain(WORKED.agent);
  });

  it("over plain http does not take the secret at all: the field is off, the words say why, and nothing is sent", async () => {
    const fake = new FakeNexus();
    const page = await openNexusPage(fake, { secure: false });

    expect(page.el.owner.hidden).toBe(false);
    expect(page.el.secret.disabled).toBe(true);
    expect(page.el["owner-go"].disabled).toBe(true);
    expect(page.el["owner-alert"].textContent).toBe("Open this page over a secure connection (https) to type the owner secret.");
    page.el.secret.value = FAKE_OWNER_SECRET;
    page.el["owner-form"].submit();
    await page.settled();
    expect(fake.calls.filter((c) => c.secret !== null), "no call carried a secret").toEqual([]);
  });

  it("keeps the secret nowhere: no storage, no cookie, and not in the page's words", async () => {
    const fake = new FakeNexus();
    const page = await openNexusPage(fake);
    // Opening the page and signing in touch no storage and write no cookie (the stand-in throws if they do).
    await page.signInWith(FAKE_OWNER_SECRET);
    expect(everythingSaid(page)).not.toContain(FAKE_OWNER_SECRET);
    expect(page.el.secret.value).toBe("");
  });
});
