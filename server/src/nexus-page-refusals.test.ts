// What the Nexus page says when Nexus refuses a call: Nexus's own words, as it sent them, on the page, in the place the owner is looking
// (a name taken under the name box, a code that ran out above the list, a remove that was turned down). The page's own HTML and script,
// as the Worker serves them, are run against the fake Nexus (__fixtures__/nexus-page-answers.ts), whose words are the real routes' words
// (nexus-page.test.ts holds the fake to them). What the page looks like is looked at in e2e/nexus.spec.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { setUpNexus } from "./__fixtures__/nexus-world";
import { GONE, GONE_EXPIRED } from "./__fixtures__/approve-answers";
import { BAD_NAME, FakeNexus, NO_IDENTITY, WORKED, taken } from "./__fixtures__/nexus-page-answers";
import { openNexusPage } from "./__fixtures__/nexus-page-world";

beforeAll(async () => {
  await setUpNexus();
});

/** The page for an owner whose browser Nexus knows (the owner's cookie). */
const ownersPage = (fake: FakeNexus) => openNexusPage(fake);

/** A long wait: past any Undo window. */
const LONG_WAIT = 60_000;

describe("the Nexus page shows Nexus's own words for a refused call", () => {
  it("a name already taken: the words are under the name box, no command is shown, and the name is left to be changed", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    page.el["agent-name"].value = WORKED.agent;
    page.el["add-form"].submit();
    await page.settled();

    expect(page.el["add-alert"].textContent, "Nexus's words, exactly").toBe(taken(WORKED.agent).error);
    expect(page.el["add-alert"].hidden).toBe(false);
    expect(page.el.command.hidden, "no command for an agent that was not added").toBe(true);
    expect(page.el["add-go"].disabled, "Add can be tapped again").toBe(false);
    expect(page.el.people.textsOf("person__name"), "nobody was added").toEqual([WORKED.owner, WORKED.agent]);
    expect(fake.callsTo("identity", "POST")).toHaveLength(1);
  });

  it("a name Nexus will not take: its words, not the page's, and a good name after it clears them", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    page.el["agent-name"].value = "Lab M";
    page.el["add-form"].submit();
    await page.settled();
    expect(page.el["add-alert"].textContent).toBe(BAD_NAME.error);

    page.el["agent-name"].value = WORKED.newAgent;
    page.el["add-form"].submit();
    await page.settled();
    expect(page.el["add-alert"].hidden, "the words are gone once it worked").toBe(true);
    expect(page.el.command.hidden).toBe(false);
  });

  it("a code that ran out: Allow shows Nexus's words above the list, and the device that can no longer be answered is taken off it", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    expect(page.el.waiting.hidden).toBe(false);
    fake.ranOut.add(WORKED.waiting.code);
    page.el.waiting.button(`Allow ${WORKED.waiting.label}`).click();
    await page.settled();

    expect(page.el.alert.textContent, "Nexus's words, exactly").toBe(GONE_EXPIRED.error);
    expect(page.el.alert.hidden).toBe(false);
    expect(page.el.waiting.children, "nothing is left to tap").toEqual([]);
    expect(page.el.waiting.hidden).toBe(true);
    expect(page.el.people.textsOf("device__label"), "and nothing was allowed").toEqual([WORKED.ownerDevice.label, WORKED.agentDevice.label]);
  });

  it("a code that was used already: the same, in Nexus's other words", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    fake.used.add(WORKED.waiting.code);
    page.el.waiting.button(`Deny ${WORKED.waiting.label}`).click();
    await page.settled();

    expect(page.el.alert.textContent).toBe(GONE.error);
    expect(page.el.waiting.children).toEqual([]);
  });

  it("a remove Nexus turns down: its words, and the row is back, because Nexus still holds what it does not know", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    // The agent was removed somewhere else while this page was open.
    page.el.people.button(`Remove ${WORKED.agent}`).click();
    expect(page.el.people.textsOf("person__name"), "the row goes at once").toEqual([WORKED.owner]);
    fake.identities = fake.identities.filter((who) => who.name !== WORKED.agent);
    await page.advance(LONG_WAIT);

    expect(page.el.alert.textContent).toBe(NO_IDENTITY.error);
    expect(page.el.people.textsOf("person__name"), "the page now shows what Nexus holds").toEqual([WORKED.owner]);
    expect(page.el.undo.hidden).toBe(true);
  });

  it("a remove Nexus answers with no words (a 500): the page says what it answered, and the row is back", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    const device = WORKED.agentDevice;
    page.el.people.button(`Remove ${device.label}`).click();
    const answer = fake.answer.bind(fake);
    // Nexus fails the remove with no words of its own; the ask for who is connected after it goes through.
    fake.answer = (method, route, body, secret) => (route === "token/revoke" ? { status: 500, json: null } : answer(method, route, body, secret));
    await page.advance(LONG_WAIT);

    expect(page.el.alert.textContent).toBe("Nexus answered 500.");
    expect(page.el.people.textsOf("device__label"), "the device is back: it was never removed").toContain(device.label);
  });
});
