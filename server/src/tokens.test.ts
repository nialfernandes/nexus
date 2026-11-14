// Tokens: an agent or a device calls Nexus with a bearer token. A token is a long random string, kept only as a
// hash and shown once, tied to one identity with a label, stamped with the time it was last used, and revocable
// at once. The owner's own sign-in keeps working as `owner`. Through the Nexus Worker; a token is got the way a device
// gets one (see __fixtures__/identity-world.ts for the three calls, the rights model and the shape of every answer).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { everythingStored, issueToken, manage, vaultAs, type Who } from "./__fixtures__/identity-world";

let ownerCookie: string;
let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
});

afterEach(() => {
  vi.useRealTimers();
});

interface TokenEntry { id: string; identity: string; label: string; createdAt: number; lastUsedAt: number | null }

const tokenEntries = async (): Promise<TokenEntry[]> => bodyOf(await manage(owner).tokens()).tokens;
const entryFor = async (label: string): Promise<TokenEntry> => {
  const found = (await tokenEntries()).filter((t) => t.label === label);
  expect(found, `exactly one token labelled ${label}`).toHaveLength(1);
  return found[0];
};

describe("a token is kept only as a hash", () => {
  it("is long, can ride in a header, and its text is in no table of Nexus's database", async () => {
    const issued = await issueToken(ownerCookie, "agents", "lab-hash");
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(issued.token, "a token has to fit in a header").toMatch(/^[\x21-\x7e]+$/);

    const stored = await everythingStored();
    expect(stored, "the database holds the token").not.toContain(issued.token);
    // The notes and versions the database holds are in that text too, so a scan that finds nothing is not a scan of nothing.
    expect(stored).toContain("nexus_notes");
  });

  it("is shown once: the list of tokens never carries it, and a second token is a different string", async () => {
    const first = await issueToken(ownerCookie, "agents", "lab-once-a");
    const second = await issueToken(ownerCookie, "agents", "lab-once-b");
    expect(first.token).not.toBe(second.token);

    const answer = await manage(owner).tokens();
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(first.token);
    expect(answer.text).not.toContain(second.token);
    expect(answer.text, "the device's own secret is not in the list either").not.toContain(first.secret);
  });

  it("is listed with the identity it works as, its label, when it was made, and no use yet", async () => {
    const before = Date.now();
    await issueToken(ownerCookie, "agents", "lab-listed");
    const entry = await entryFor("lab-listed");
    expect(entry).toMatchObject({ identity: "agents", label: "lab-listed", lastUsedAt: null });
    expect(typeof entry.id, "a token has an id, as text, to revoke it by").toBe("string");
    expect(entry.id).not.toBe("");
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("is told apart from another token of the same identity by its id", async () => {
    await issueToken(ownerCookie, "agents", "lab-twin-a");
    await issueToken(ownerCookie, "agents", "lab-twin-b");
    expect((await entryFor("lab-twin-a")).id).not.toBe((await entryFor("lab-twin-b")).id);
  });
});

describe("a bearer token is how an agent or a device is let in", () => {
  it("lets the holder in as the identity it was made for, and the notes it saves are theirs", async () => {
    const { token } = await issueToken(ownerCookie, "agents", "lab-in");
    const agent: Who = { bearer: token };
    expect((await vaultAs(agent).list()).status).toBe(200);
    expect(bodyOf(await vaultAs(agent).save("Tokens/by-token.md", "hello\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note("Tokens/by-token.md"))).toMatchObject({ writer: "agents" });
  });

  it("lets a token made for owner write anywhere, as owner", async () => {
    const phone: Who = { bearer: (await issueToken(ownerCookie, "owner", "the owner's phone")).token };
    expect(bodyOf(await vaultAs(phone).save("Private/from-phone.md", "typed on the phone\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note("Private/from-phone.md"))).toMatchObject({ writer: "owner" });
  });

  it("answers 401 to a token nobody made, an empty one, and a scheme that is not Bearer", async () => {
    expectRefusal(await vaultAs({ bearer: "not-a-token-nexus-ever-made-0123456789abcdef" }).list(), 401, "an unknown token");
    expectRefusal(await vaultAs({ bearer: "" }).list(), 401, "an empty token");
    const { token } = await issueToken(ownerCookie, "agents", "lab-scheme");
    expectRefusal(await vaultAs({ authorization: `Basic ${token}` }).list(), 401, "a real token under the Basic scheme");
    expectRefusal(await vaultAs({ authorization: token }).list(), 401, "a real token with no scheme");

    // And a turned-away save keeps nothing.
    expect((await vaultAs({ bearer: "still-not-a-token-0123456789abcdef0123456789" }).save("Tokens/never.md", "x\n")).status).toBe(401);
    expect((await vaultAs({ authorization: `Basic ${token}` }).save("Tokens/never.md", "x\n")).status).toBe(401);
    expectRefusal(await vaultAs(owner).note("Tokens/never.md"), 404, "the note a turned-away token tried to make");
  });
});

describe("the time a token was last used", () => {
  it("is empty until the token is used, and then is the time of its use, moving on with each use", async () => {
    const { token } = await issueToken(ownerCookie, "agents", "lab-last-used");
    expect((await entryFor("lab-last-used")).lastUsedAt, "approving and handing it over is not a use").toBeNull();

    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 60_000);
    expect((await vaultAs({ bearer: token }).list()).status).toBe(200);
    const first = (await entryFor("lab-last-used")).lastUsedAt;
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThanOrEqual(start + 60_000 - 1000);
    expect(first!).toBeLessThanOrEqual(start + 60_000);

    vi.setSystemTime(start + 3_600_000);
    expect((await vaultAs({ bearer: token }).list()).status).toBe(200);
    const second = (await entryFor("lab-last-used")).lastUsedAt;
    expect(second!).toBeGreaterThanOrEqual(start + 3_600_000 - 1000);
    expect(second!).toBeLessThanOrEqual(start + 3_600_000);
  });

  it("is not touched by a token that was not used", async () => {
    await issueToken(ownerCookie, "agents", "lab-idle");
    const { token } = await issueToken(ownerCookie, "agents", "lab-busy");
    expect((await vaultAs({ bearer: token }).list()).status).toBe(200);
    expect((await entryFor("lab-idle")).lastUsedAt).toBeNull();
    expect((await entryFor("lab-busy")).lastUsedAt).not.toBeNull();
  });
});

describe("a revoked token is turned away at once", () => {
  it("answers 401 on the very next request, and leaves the identity's other tokens working", async () => {
    const lost = await issueToken(ownerCookie, "agents", "lab-lost");
    const kept = await issueToken(ownerCookie, "agents", "lab-kept");
    expect((await vaultAs({ bearer: lost.token }).list()).status, "before revoking").toBe(200);

    const entry = await entryFor("lab-lost");
    expect(bodyOf(await manage(owner).revoke(entry.id))).toMatchObject({ result: "revoked", id: entry.id });

    expectRefusal(await vaultAs({ bearer: lost.token }).list(), 401, "the revoked token");
    expect((await vaultAs({ bearer: lost.token }).save("Tokens/after-revoke.md", "x\n")).status).toBe(401);
    expect((await vaultAs({ bearer: kept.token }).list()).status, "the identity's other token").toBe(200);
    expectRefusal(await vaultAs(owner).note("Tokens/after-revoke.md"), 404, "the note the revoked token tried to make");
  });
});
