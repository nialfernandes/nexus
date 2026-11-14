// Managing identities and rights: creating an identity, setting its folder rights, listing and revoking tokens.
// Only `owner` may call these routes, whether through the owner's own sign-in or a token made for `owner`; any other identity
// is turned away, and `owner`'s own rights cannot be narrowed or removed. Through the Nexus Worker (see
// __fixtures__/identity-world.ts for the rights model and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { issueToken, manage, tokenFor, vaultAs, type FolderRight, type Who } from "./__fixtures__/identity-world";

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

const IDEAS_WRITE: FolderRight[] = [{ path: "Ideas/", access: "write" }];

describe("creating an identity", () => {
  it("makes one with a name, a kind and folder rights, and answers with what it made", async () => {
    expect(bodyOf(await manage(owner).createIdentity("scribe", "person", IDEAS_WRITE))).toMatchObject({
      name: "scribe", kind: "person", rights: IDEAS_WRITE,
    });
    expect(bodyOf(await manage(owner).createIdentity("lab-two", "agent", [{ path: "Reference/", access: "read" }]))).toMatchObject({ kind: "agent" });
    expect(bodyOf(await manage(owner).createIdentity("podcast-app", "app", IDEAS_WRITE))).toMatchObject({ kind: "app" });
  });

  it("is a name the new identity can be given a token for, and what it writes carries that name", async () => {
    bodyOf(await manage(owner).createIdentity("named-writer", "agent", IDEAS_WRITE));
    const writer: Who = tokenFor(() => ownerCookie, "named-writer", "named device");
    bodyOf(await vaultAs(writer).save("Ideas/named.md", "by name\n"));
    expect(bodyOf(await vaultAs(owner).note("Ideas/named.md"))).toMatchObject({ writer: "named-writer" });
  });

  it("starts with no rights at all when none are given", async () => {
    bodyOf(await manage(owner).createIdentity("no-rights", "agent"));
    const nobody: Who = tokenFor(() => ownerCookie, "no-rights", "no-rights device");
    bodyOf(await vaultAs(owner).save("Ideas/no-rights-target.md", "x\n"));
    const refused = await vaultAs(nobody).note("Ideas/no-rights-target.md");
    expectRefusal(refused, 403, "a read by an identity with no rights");
    expect(refused.body.error).toContain("Ideas/no-rights-target.md");
    expectRefusal(await vaultAs(nobody).save("Ideas/no-rights-new.md", "x\n"), 403, "a write by an identity with no rights");
  });

  it("refuses a kind that is not person, agent or app, a blank name, and a name that is taken", async () => {
    expectRefusal(await manage(owner).createIdentity("robot-kind", "robot"), 400, "a kind that does not exist");
    expectRefusal(await manage(owner).createIdentity("", "agent"), 400, "a blank name");
    expectRefusal(await manage(owner).createIdentity("   ", "agent"), 400, "a name of spaces");
    expectRefusal(await manage(owner).createIdentity("scribe", "agent"), 409, "a name already made");
    expectRefusal(await manage(owner).createIdentity("agents", "agent"), 409, "a seeded name");
    expectRefusal(await manage(owner).createIdentity("owner", "person"), 409, "owner");
    expectRefusal(await manage(owner).createIdentity("robot-kind", "agent", [{ path: "Ideas/", access: "admin" as never }]), 400, "an access that does not exist");
  });
});

describe("setting an identity's folder rights", () => {
  it("replaces the whole list, and the very next request is held to the new rights", async () => {
    bodyOf(await manage(owner).createIdentity("moving-rights", "agent", IDEAS_WRITE));
    const holder: Who = tokenFor(() => ownerCookie, "moving-rights", "moving device");
    expect(bodyOf(await vaultAs(holder).save("Ideas/moving.md", "one\n"))).toMatchObject({ result: "saved" });

    const readOnly: FolderRight[] = [{ path: "Ideas/", access: "read" }];
    expect(bodyOf(await manage(owner).setRights("moving-rights", readOnly))).toMatchObject({ identity: "moving-rights", rights: readOnly });
    expect(bodyOf(await vaultAs(holder).note("Ideas/moving.md"))).toMatchObject({ text: "one\n" });
    const refused = await vaultAs(holder).save("Ideas/moving.md", "two\n", { base: 1 });
    expectRefusal(refused, 403, "a write after the rights became read");
    expect(refused.body.error).toContain("Ideas/moving.md");

    expect(bodyOf(await manage(owner).setRights("moving-rights", []))).toMatchObject({ rights: [] });
    expectRefusal(await vaultAs(holder).note("Ideas/moving.md"), 403, "a read after the rights were emptied");

    bodyOf(await manage(owner).setRights("moving-rights", IDEAS_WRITE));
    expect(bodyOf(await vaultAs(holder).save("Ideas/moving.md", "three\n", { base: 1 }))).toMatchObject({ result: "saved", version: 2 });
  });

  it("is refused for an identity that does not exist and for an access that does not exist", async () => {
    expectRefusal(await manage(owner).setRights("nobody-by-this-name", IDEAS_WRITE), 404, "an unknown identity");
    expectRefusal(await manage(owner).setRights("scribe", [{ path: "Ideas/", access: "admin" as never }]), 400, "an access that does not exist");
    expect(bodyOf(await manage(owner).setRights("scribe", IDEAS_WRITE))).toMatchObject({ rights: IDEAS_WRITE });
  });

  it("can give a seeded identity more, or less, than it had", async () => {
    const narrower: FolderRight[] = [{ path: "Podcasts/Transcripts/", access: "write" }, { path: "Podcasts/Notes/", access: "read" }];
    bodyOf(await manage(owner).setRights("recorder", narrower));
    bodyOf(await vaultAs(owner).save("Podcasts/Notes/show.md", "notes\n"));
    expect(bodyOf(await vaultAs(recorder).note("Podcasts/Notes/show.md"))).toMatchObject({ text: "notes\n" });
    expectRefusal(await vaultAs(recorder).save("Podcasts/Notes/show.md", "x\n", { base: 1 }), 403, "a write to a read-only folder");
    bodyOf(await manage(owner).setRights("recorder", [{ path: "Podcasts/Transcripts/", access: "write" }]));
  });
});

describe("only owner can manage identities and rights", () => {
  it("turns away nobody and a signed-in stranger with 401", async () => {
    expect((await manage(owner).tokens()).status, "the same call from owner").toBe(200);
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      expectRefusal(await manage(who).createIdentity("sneak", "agent"), 401, `${what} creating an identity`);
      expectRefusal(await manage(who).setRights("agents", [{ path: "", access: "write" }]), 401, `${what} setting rights`);
      expectRefusal(await manage(who).tokens(), 401, `${what} listing tokens`);
      expectRefusal(await manage(who).revoke("1"), 401, `${what} revoking a token`);
    }
  });

  it("turns away every other identity with 403, whatever its rights", async () => {
    for (const [who, what] of [[agents, "agents"], [recorder, "recorder"]] as const) {
      expectRefusal(await manage(who).createIdentity("sneak", "agent"), 403, `${what} creating an identity`);
      expectRefusal(await manage(who).setRights("agents", [{ path: "", access: "write" }]), 403, `${what} setting rights`);
      expectRefusal(await manage(who).tokens(), 403, `${what} listing tokens`);
      expectRefusal(await manage(who).revoke("1"), 403, `${what} revoking a token`);
    }
  });

  it("changes nothing for them: no identity was made, and agents did not gain Private/", async () => {
    bodyOf(await vaultAs(owner).save("Private/admin-secret.md", "still private\n"));
    expectRefusal(await vaultAs(agents).note("Private/admin-secret.md"), 403, "agents reading Private/ after trying to grant itself");
    expect(bodyOf(await manage(owner).createIdentity("sneak", "agent")), "owner can still make the name, so nobody else did").toMatchObject({ name: "sneak" });
  });

  it("turns away an agent that tries to revoke a token, its own included", async () => {
    const mine = await issueToken(ownerCookie, "agents", "admin-test revoke-me");
    const entry = bodyOf(await manage(owner).tokens()).tokens.find((t: { label: string }) => t.label === "admin-test revoke-me");
    expectRefusal(await manage({ bearer: mine.token }).revoke(entry.id), 403, "an agent revoking a token");
    expect((await vaultAs({ bearer: mine.token }).list()).status, "the token still works").toBe(200);
  });

  it("lets a token made for owner manage, because it is owner", async () => {
    const phone: Who = tokenFor(() => ownerCookie, "owner", "admin-test phone");
    expect(bodyOf(await manage(phone).createIdentity("made-from-phone", "agent", IDEAS_WRITE))).toMatchObject({ name: "made-from-phone" });
    expect(bodyOf(await manage(phone).tokens()).tokens.length).toBeGreaterThan(0);
    expect(bodyOf(await manage(phone).setRights("made-from-phone", []))).toMatchObject({ rights: [] });
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

describe("owner's rights cannot be narrowed or removed", () => {
  it("refuses a narrower list, an emptied list, and a list that shuts a folder, and owner still writes everywhere", async () => {
    // The same call works for an identity that is not owner, so a refusal below is owner's rule and not a missing route.
    bodyOf(await manage(owner).createIdentity("narrow-check", "agent"));
    expect(bodyOf(await manage(owner).setRights("narrow-check", [{ path: "Ideas/", access: "read" }]))).toMatchObject({ identity: "narrow-check" });
    const attempts: Array<[FolderRight[], string]> = [
      [[{ path: "Ideas/", access: "read" }], "read on one folder"],
      [[], "no rights at all"],
      [[{ path: "", access: "write" }, { path: "Private/", access: "none" }], "everything except Private/"],
      [[{ path: "", access: "read" }], "read on everything"],
    ];
    for (const [rights, what] of attempts) {
      const answer = await manage(owner).setRights("owner", rights);
      expect([400, 403, 409], `narrowing owner to ${what}: status ${answer.status} (${answer.text.slice(0, 100)})`).toContain(answer.status);
      expect(typeof answer.body?.error, `narrowing owner to ${what}: a plain refusal`).toBe("string");
    }

    expect(bodyOf(await vaultAs(owner).save("Private/still-owner.md", "owner still writes here\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).save("Ideas/still-owner.md", "and here\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note("Private/still-owner.md"))).toMatchObject({ writer: "owner" });
    expect((await manage(owner).tokens()).status, "owner can still manage").toBe(200);
  });

  it("holds for a token made for owner as well", async () => {
    const phone: Who = tokenFor(() => ownerCookie, "owner", "admin-test narrow-me");
    const answer = await manage(phone).setRights("owner", []);
    expect([400, 403, 409], `emptying owner's rights with owner's token: status ${answer.status}`).toContain(answer.status);
    expect(bodyOf(await vaultAs(phone).save("Private/phone-still-owner.md", "x\n"))).toMatchObject({ result: "saved" });
  });
});
