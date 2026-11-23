// What the Nexus page says when Nexus refuses a call: Nexus's own words, as it sent them, on the page, in the place the owner is looking
// (a code that ran out above the list, a remove that was turned down, a refusal Nexus words itself under the name box); and, for a name that
// is already an agent, the words drawn on board 27a. The page's own HTML and script,
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

/** Opens the add form (the Add on the bar), types a name as a person does, and sends it. */
async function addAgentNamed(page: Awaited<ReturnType<typeof ownersPage>>, name: string) {
  page.el["add-open"].click();
  page.el["agent-name"].enter(name);
  page.el["add-form"].submit();
  await page.settled();
}

describe("the Nexus page shows Nexus's own words for a refused call", () => {
  it("a name already an agent: the words drawn on board 27a under the name box in red, the name is left to be changed, Add is dim, and no command is shown", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    await addAgentNamed(page, WORKED.agent);

    expect(page.el["agent-hint"].textContent, "the drawn words, built from the name").toBe("There's already an agent called scribe.");
    expect(page.el["agent-hint"].className, "in red").toContain("card__quiet--taken");
    expect(page.el["agent-name"].attributes["aria-invalid"], "the outline is red").toBe("true");
    expect(page.el["agent-name"].value, "the name is left to be changed").toBe(WORKED.agent);
    expect(page.el["add-go"].disabled, "Add stays dim").toBe(true);
    expect(page.el["add-alert"].hidden).toBe(true);
    expect(page.el.command.hidden, "no command for an agent that was not added").toBe(true);
    expect(page.el.people.textsOf("person__name"), "nobody was added").toEqual(["you", WORKED.agent]);
    expect(fake.callsTo("identity", "POST")).toHaveLength(1);
    // Pressing Enter on it sends nothing more.
    page.el["add-form"].submit();
    await page.settled();
    expect(fake.callsTo("identity", "POST")).toHaveLength(1);

    // Typing anything clears the red at once, and the next name can be sent.
    page.el["agent-name"].enter("scribe2");
    expect(page.el["agent-hint"].textContent).toBe("Lower case letters, digits and hyphens.");
    expect(page.el["agent-hint"].className).not.toContain("card__quiet--taken");
    expect(page.el["agent-name"].attributes["aria-invalid"]).toBeUndefined();
    expect(page.el["add-go"].disabled).toBe(false);
  });

  it("a name that is taken but is not an agent (the owner's): Nexus's own words, since the drawn ones say agent", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    await addAgentNamed(page, WORKED.owner);

    expect(page.el["agent-hint"].textContent, "Nexus's words, exactly").toBe(taken(WORKED.owner).error);
    expect(page.el["agent-hint"].className).toContain("card__quiet--taken");
    expect(page.el["add-go"].disabled).toBe(true);
    expect(page.el.command.hidden).toBe(true);
  });

  it("letters Nexus does not allow are blocked as they are typed, so the words Nexus has for a bad name are never needed: nothing is sent for one", async () => {
    const fake = new FakeNexus({ knownOwner: true });
    const page = await ownersPage(fake);
    page.el["add-open"].click();
    page.el["agent-name"].enter("Lab M");
    expect(page.el["agent-name"].value, "the capital letters and the space are not let in").toBe("ab");
    page.el["agent-name"].enter("-lab");
    expect(page.el["add-go"].disabled, "a name does not begin with a hyphen").toBe(true);
    page.el["add-form"].submit();
    await page.settled();
    expect(fake.callsTo("identity"), "not even sent").toEqual([]);
    expect(page.el["add-alert"].hidden).toBe(true);
    expect(BAD_NAME.error, "Nexus's words for it stay what the fake holds to the real route (nexus-page.test.ts)").toMatch(/lower case letters/);

    page.el["agent-name"].enter(WORKED.newAgent);
    page.el["add-form"].submit();
    await page.settled();
    expect(page.el["add-alert"].hidden).toBe(true);
    expect(page.el.command.hidden, "a good name was added").toBe(false);
  });

  it("a refusal for too many waiting sign-ins (a 429 with plain words): shown as any other refusal is, whichever call it came on", async () => {
    const words = "Too many sign-ins are waiting. Try again in a few minutes.";
    const fake = new FakeNexus({ knownOwner: true });
    const answer = fake.answer.bind(fake);
    fake.answer = (method, route, body, secret) => (method === "POST" && route === "identity" ? { status: 429, json: { error: words } } : answer(method, route, body, secret));
    const page = await ownersPage(fake);
    await addAgentNamed(page, WORKED.newAgent);

    expect(page.el["add-alert"].textContent, "the server's words, whatever the status").toBe(words);
    expect(page.el["add-alert"].hidden).toBe(false);
    expect(page.el.command.hidden).toBe(true);
    expect(page.el["agent-hint"].className, "and the name is not called taken").not.toContain("card__quiet--taken");
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
    expect(page.el.line.textContent, "no word of ours says it worked").not.toMatch(/can use Nexus now/);
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
    page.el.people.button(WORKED.agent).click();
    page.el["remove-agent"].click();
    expect(page.el.people.textsOf("person__name"), "the row goes at once").toEqual(["you"]);
    fake.identities = fake.identities.filter((who) => who.name !== WORKED.agent);
    await page.advance(LONG_WAIT);

    expect(page.el.alert.textContent).toBe(NO_IDENTITY.error);
    expect(page.el.people.textsOf("person__name"), "the page now shows what Nexus holds").toEqual(["you"]);
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
