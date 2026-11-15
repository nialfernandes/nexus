// Managing identities and the key wraps: creating an identity, listing and revoking tokens, keeping and removing a wrap.
// Only `owner` may call these routes, whether through the owner's own sign-in or a token made for `owner`; any other
// identity is turned away. There are no folder rights: an identity that is let in can use every note, and the old
// `rights` field and route are refused. Through the Nexus Worker (see __fixtures__/identity-world.ts for what an
// identity may do and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import {
  GARDEN_V1, PASSWORD_WRAP, PODCAST_V1, RECOVERY_WRAP, RECOVERY_WRAP_KID_0, RECOVERY_WRAP_KID_1_AGAIN, RECOVERY_WRAP_KID_2, RECOVERY_WRAP_KID_MAX,
} from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { issueToken, manage, sendAs, tokenFor, vaultAs, writerOf, type Who } from "./__fixtures__/identity-world";

let ownerCookie: string;
let owner: Who;
let stranger: Who;
let agents: Who;
let recorder: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  stranger = { cookie: (await signInStranger()).cookie };
  agents = tokenFor(() => ownerCookie, "agents", "admin-test agents");
  recorder = tokenFor(() => ownerCookie, "recorder", "admin-test recorder");
});

describe("creating an identity", () => {
  it("makes one with a name and a kind, and answers with what it made", async () => {
    expect(bodyOf(await manage(owner).createIdentity("scribe", "person"))).toEqual({ name: "scribe", kind: "person" });
    expect(bodyOf(await manage(owner).createIdentity("lab-two", "agent"))).toMatchObject({ kind: "agent" });
    expect(bodyOf(await manage(owner).createIdentity("podcast-app", "app"))).toMatchObject({ kind: "app" });
  });

  it("is a name the new identity can be given a token for, and what it writes carries that token's device", async () => {
    bodyOf(await manage(owner).createIdentity("named-writer", "agent"));
    const writer: Who = tokenFor(() => ownerCookie, "named-writer", "named device");
    bodyOf(await vaultAs(writer).save(GARDEN_V1, 0));
    expect(bodyOf(await vaultAs(owner).note(GARDEN_V1.id))).toMatchObject({ writer: await writerOf(ownerCookie, "named device") });
  });

  it("refuses a kind that is not person, agent or app, a blank name, and a name that is taken", async () => {
    expectRefusal(await manage(owner).createIdentity("robot-kind", "robot"), 400, "a kind that does not exist");
    expectRefusal(await manage(owner).createIdentity("", "agent"), 400, "a blank name");
    expectRefusal(await manage(owner).createIdentity("   ", "agent"), 400, "a name of spaces");
    expectRefusal(await manage(owner).createIdentity("scribe", "agent"), 409, "a name already made");
    expectRefusal(await manage(owner).createIdentity("agents", "agent"), 409, "a seeded name");
    expectRefusal(await manage(owner).createIdentity("owner", "person"), 409, "owner");
  });

  it("refuses folder rights, which are gone, and any other field, and makes no identity", async () => {
    const withRights = await sendAs("POST", `${API}/identity`, owner, { name: "wide-by-mistake", kind: "agent", rights: [{ path: "Ideas/", access: "read" }] });
    expectRefusal(withRights, 400, "an identity made with folder rights");
    expect(withRights.body.error).toMatch(/Folder rights are gone/);
    expectRefusal(await sendAs("POST", `${API}/identity`, owner, { name: "wide-by-mistake", kind: "agent", colour: "red" }), 400, "an unknown field");
    expect(bodyOf(await manage(owner).createIdentity("wide-by-mistake", "agent")), "the name was never taken").toMatchObject({ name: "wide-by-mistake" });
  });

  it("has no route that sets rights any more", async () => {
    expectRefusal(await sendAs("POST", `${API}/rights`, owner, { identity: "agents", rights: [] }), 404, "the old rights route");
  });
});

describe("an identity that is let in can use every note", () => {
  it("lets agents and recorder alike save, read and delete, since there is no folder to hold them to", async () => {
    expect(bodyOf(await vaultAs(agents).save(PODCAST_V1, 0))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await vaultAs(recorder).note(PODCAST_V1.id))).toMatchObject({ writer: await writerOf(ownerCookie, "admin-test agents") });
    expect(bodyOf(await vaultAs(recorder).remove(PODCAST_V1.id, 1))).toMatchObject({ result: "deleted", version: 2 });
  });
});

describe("only owner can manage identities, tokens and wraps", () => {
  it("turns away nobody and a signed-in stranger with 401", async () => {
    expect((await manage(owner).tokens()).status, "the same call from owner").toBe(200);
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      expectRefusal(await manage(who).createIdentity("sneak", "agent"), 401, `${what} creating an identity`);
      expectRefusal(await manage(who).tokens(), 401, `${what} listing tokens`);
      expectRefusal(await manage(who).revoke("1"), 401, `${what} revoking a token`);
      expectRefusal(await manage(who).setWrap(1, "recovery", RECOVERY_WRAP), 401, `${what} keeping a wrap`);
      expectRefusal(await manage(who).removeWrap(1, "recovery"), 401, `${what} removing a wrap`);
    }
  });

  it("turns away every other identity with 403", async () => {
    for (const [who, what] of [[agents, "agents"], [recorder, "recorder"]] as const) {
      expectRefusal(await manage(who).createIdentity("sneak", "agent"), 403, `${what} creating an identity`);
      expectRefusal(await manage(who).tokens(), 403, `${what} listing tokens`);
      expectRefusal(await manage(who).revoke("1"), 403, `${what} revoking a token`);
      expectRefusal(await manage(who).setWrap(1, "recovery", RECOVERY_WRAP), 403, `${what} keeping a wrap`);
      expectRefusal(await manage(who).removeWrap(1, "recovery"), 403, `${what} removing a wrap`);
    }
  });

  it("changes nothing for them: no identity was made and no wrap was kept", async () => {
    expect(bodyOf(await manage(owner).createIdentity("sneak", "agent")), "owner can still make the name, so nobody else did").toMatchObject({ name: "sneak" });
    expect(bodyOf(await vaultAs(owner).wraps()).wraps, "no wrap was kept").toEqual([]);
  });

  it("turns away an agent that tries to revoke a token, its own included", async () => {
    const mine = await issueToken(ownerCookie, "agents", "admin-test revoke-me");
    const entry = bodyOf(await manage(owner).tokens()).tokens.find((t: { label: string }) => t.label === "admin-test revoke-me");
    expectRefusal(await manage({ bearer: mine.token }).revoke(entry.id), 403, "an agent revoking a token");
    expect((await vaultAs({ bearer: mine.token }).list()).status, "the token still works").toBe(200);
  });

  it("lets a token made for owner manage, because it is owner", async () => {
    const phone: Who = tokenFor(() => ownerCookie, "owner", "admin-test phone");
    expect(bodyOf(await manage(phone).createIdentity("made-from-phone", "agent"))).toMatchObject({ name: "made-from-phone" });
    expect(bodyOf(await manage(phone).tokens()).tokens.length).toBeGreaterThan(0);
    expect(bodyOf(await manage(phone).setWrap(1, "recovery", RECOVERY_WRAP))).toMatchObject({ result: "saved" });
    bodyOf(await manage(phone).removeWrap(1, "recovery"));
  });
});

describe("revoking a token", () => {
  it("revokes one that is there, and refuses an id that is not a token's", async () => {
    await issueToken(ownerCookie, "agents", "admin-test to-revoke");
    const entry = bodyOf(await manage(owner).tokens()).tokens.find((t: { label: string }) => t.label === "admin-test to-revoke");
    expect(bodyOf(await manage(owner).revoke(entry.id))).toMatchObject({ result: "revoked", id: entry.id });
    expectRefusal(await manage(owner).revoke("no-such-token-id"), 404, "an unknown token id");
  });
});

describe("the vault key's wraps", () => {
  it("are kept as sent, listed to any identity, replaced for the same kid and kind, and removed", async () => {
    expect(bodyOf(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP))).toEqual({ result: "saved", kid: 1, kind: "recovery" });
    expect(bodyOf(await manage(owner).setWrap(1, "password", PASSWORD_WRAP))).toMatchObject({ kind: "password" });

    const listed = bodyOf(await vaultAs(agents).wraps()).wraps;
    expect(listed.map((w: { kid: number; kind: string; wrap: string; writer: string }) => [w.kid, w.kind, w.wrap, w.writer])).toEqual([
      [1, "password", PASSWORD_WRAP, "owner"],
      [1, "recovery", RECOVERY_WRAP, "owner"],
    ]);
    expect(typeof listed[0].at).toBe("number");

    // The same kid and kind replaces the wrap: a second kid sits beside it.
    bodyOf(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP_KID_1_AGAIN));
    bodyOf(await manage(owner).setWrap(2, "recovery", RECOVERY_WRAP_KID_2));
    const after = bodyOf(await vaultAs(owner).wraps()).wraps;
    expect(after.map((w: { kid: number; kind: string; wrap: string }) => [w.kid, w.kind, w.wrap])).toEqual([
      [1, "password", PASSWORD_WRAP],
      [1, "recovery", RECOVERY_WRAP_KID_1_AGAIN],
      [2, "recovery", RECOVERY_WRAP_KID_2],
    ]);

    expect(bodyOf(await manage(owner).removeWrap(1, "password"))).toEqual({ result: "removed", kid: 1, kind: "password" });
    expectRefusal(await manage(owner).removeWrap(1, "password"), 404, "removing a wrap twice");
    expect(bodyOf(await vaultAs(owner).wraps()).wraps).toHaveLength(2);
    bodyOf(await manage(owner).removeWrap(1, "recovery"));
    bodyOf(await manage(owner).removeWrap(2, "recovery"));
  });

  it("are refused when the kid, the kind or the wrap is not what a wrap is, and nothing is kept", async () => {
    expectRefusal(await manage(owner).setWrap(-1, "recovery", RECOVERY_WRAP), 400, "a negative kid");
    expectRefusal(await manage(owner).setWrap(4294967296, "recovery", RECOVERY_WRAP), 400, "a kid over four bytes");
    expectRefusal(await manage(owner).setWrap(1.5, "recovery", RECOVERY_WRAP), 400, "a kid that is not whole");
    expectRefusal(await manage(owner).setWrap(1, "sealed", RECOVERY_WRAP), 400, "a kind that is not a wrap");
    expectRefusal(await manage(owner).setWrap(1, "recovery", "not base64!"), 400, "a wrap that is not base64");
    expectRefusal(await manage(owner).setWrap(1, "recovery", ""), 400, "an empty wrap");
    expectRefusal(await manage(owner).setWrap(1, "recovery", "A".repeat(2000)), 413, "a wrap that is too long");
    expectRefusal(await sendAs("POST", `${API}/wrap`, owner, { kid: 1, kind: "recovery", wrap: RECOVERY_WRAP, note: "x" }), 400, "a field that is not a wrap's");
    expect(bodyOf(await vaultAs(owner).wraps()).wraps).toEqual([]);
  });

  it("can hold the kid 0 and the largest kid", async () => {
    bodyOf(await manage(owner).setWrap(0, "recovery", RECOVERY_WRAP_KID_0));
    bodyOf(await manage(owner).setWrap(4294967295, "recovery", RECOVERY_WRAP_KID_MAX));
    expect(bodyOf(await vaultAs(owner).wraps()).wraps.map((w: { kid: number }) => w.kid)).toEqual([0, 4294967295]);
    bodyOf(await manage(owner).removeWrap(0, "recovery"));
    bodyOf(await manage(owner).removeWrap(4294967295, "recovery"));
  });
});
