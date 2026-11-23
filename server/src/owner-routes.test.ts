// The two owner routes the Nexus page needs: GET identities (who is connected, and with which devices) and POST
// identity/remove (take an agent away, every device of it at once). Through the Nexus Worker (see
// __fixtures__/identity-world.ts for the shape of every answer).
//
// Each test builds a world of its own (nexusEnv), so the list is exactly what the test made: the owner, and the identities
// the test named. A token is got as a device gets one (start, the owner approves, the device polls), never planted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { device, manage, sendAs, vaultAs, type Who } from "./__fixtures__/identity-world";
import { API, OWNER, OWNER_SECRET, bodyOf, expectRefusal, nexusEnv, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import type { NexusEnv } from "./plugs/cloudflare/host";

const START = Date.UTC(2026, 10, 23, 9, 0, 0);
const MINUTE = 60 * 1000;

let env: NexusEnv;
let owner: Who;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  env = await nexusEnv();
  owner = { cookie: (await signInOwner()).cookie };
});

afterEach(() => {
  vi.useRealTimers();
});

/** One device signed in as `identity`, the way a device gets a token: its token, and the id the owner sees for it. */
async function connect(identity: string, label: string): Promise<{ token: string; id: string; who: Who }> {
  const started = bodyOf(await device(null, env).start(identity, label));
  bodyOf(await device(owner, env).approve(started.code));
  const polled = bodyOf(await device(null, env).poll(started.secret));
  const listed = bodyOf(await manage(owner, env).tokens()).tokens as Array<{ id: string; label: string; identity: string }>;
  const mine = listed.filter((t) => t.identity === identity && t.label === label);
  expect(mine, `one token for ${identity} labelled ${label}`).toHaveLength(1);
  return { token: polled.token, id: mine[0]!.id, who: { bearer: polled.token } };
}

const identitiesOf = async (who: Who = owner) => bodyOf(await manage(who, env).identities()).identities as Array<{
  name: string; kind: string; owner: boolean; createdAt: number | null; devices: Array<{ id: string; label: string; createdAt: number; lastUsedAt: number | null }>;
}>;
const namesOf = async (who: Who = owner) => (await identitiesOf(who)).map((i) => i.name);

describe("GET identities", () => {
  it("is the worked example: the owner first, then lab-m with no devices, then scribe with its one working device", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    bodyOf(await manage(owner, env).createIdentity("lab-m", "agent"));
    const old = await connect("scribe", "scribe's old laptop");
    vi.setSystemTime(START + MINUTE);
    const current = await connect("scribe", "scribe's server");
    bodyOf(await manage(owner, env).revoke(old.id));

    const listed = await identitiesOf();
    expect(listed.map((i) => i.name)).toEqual([OWNER, "lab-m", "scribe"]);
    expect(listed[0]).toEqual({ name: OWNER, kind: "person", owner: true, createdAt: null, devices: [] });
    expect(listed[1]).toMatchObject({ name: "lab-m", kind: "agent", owner: false, createdAt: START, devices: [] });
    expect(listed[2]).toMatchObject({ name: "scribe", kind: "agent", createdAt: START });
    expect(listed[2]!.devices, "the revoked device is not listed").toEqual([{ id: current.id, label: "scribe's server", createdAt: START + MINUTE, lastUsedAt: null }]);

    expect(bodyOf(await manage(owner, env).removeIdentity("scribe")), "one device was still working, one had been revoked").toEqual({ result: "removed", name: "scribe", revoked: 1 });
    expectRefusal(await vaultAs(current.who, env).list(), 401, "scribe's token after it was removed");
    expectRefusal(await vaultAs(old.who, env).list(), 401, "scribe's revoked token, still");
    expect(await namesOf()).toEqual([OWNER, "lab-m"]);
  });

  it("marks only the owner as the owner", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    expect((await identitiesOf()).map((i) => [i.name, i.owner])).toEqual([[OWNER, true], ["scribe", false]]);
  });

  it("lists the owner first even when its name sorts last, with its row once it has one and its devices", async () => {
    bodyOf(await manage(owner, env).createIdentity("agents", "agent"));
    bodyOf(await manage(owner, env).createIdentity("zed", "app"));
    expect(await namesOf()).toEqual([OWNER, "agents", "zed"]);

    vi.setSystemTime(START + 5 * MINUTE);
    const phone = await connect(OWNER, "the owner's phone");
    const listed = await identitiesOf();
    expect(listed.map((i) => i.name), "the owner is still once, and first").toEqual([OWNER, "agents", "zed"]);
    expect(listed[0]).toMatchObject({ name: OWNER, kind: "person", createdAt: START + 5 * MINUTE });
    expect(listed[0]!.devices.map((d) => d.id)).toEqual([phone.id]);
  });

  it("lists the devices newest first, with when each was last used, and never a token or anything made from one", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    const first = await connect("scribe", "first");
    vi.setSystemTime(START + MINUTE);
    const second = await connect("scribe", "second");
    vi.setSystemTime(START + 2 * MINUTE);
    const third = await connect("scribe", "third");

    vi.setSystemTime(START + 10 * MINUTE);
    bodyOf(await vaultAs(first.who, env).list());
    const answer = await manage(owner, env).identities();
    const scribe = bodyOf(answer).identities.find((i: { name: string }) => i.name === "scribe");
    expect(scribe.devices.map((d: { label: string }) => d.label)).toEqual(["third", "second", "first"]);
    expect(scribe.devices.map((d: { id: string }) => d.id)).toEqual([third.id, second.id, first.id]);
    expect(scribe.devices.map((d: { lastUsedAt: number | null }) => d.lastUsedAt)).toEqual([null, null, START + 10 * MINUTE]);
    for (const d of scribe.devices) expect(Object.keys(d).sort(), "a device holds only these").toEqual(["createdAt", "id", "label", "lastUsedAt"]);
    for (const t of [first, second, third]) expect(answer.text, "no token in the answer").not.toContain(t.token);
    expect(answer.text).not.toMatch(/nx_|token_hash|secret/);
  });

  it("lists every device of each identity under its own name", async () => {
    bodyOf(await manage(owner, env).createIdentity("lab-m", "agent"));
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    const a = await connect("lab-m", "a");
    const b = await connect("scribe", "b");
    const listed = await identitiesOf();
    expect(listed.find((i) => i.name === "lab-m")!.devices.map((d) => d.id)).toEqual([a.id]);
    expect(listed.find((i) => i.name === "scribe")!.devices.map((d) => d.id)).toEqual([b.id]);
  });
});

describe("POST identity/remove", () => {
  it("takes away an identity's devices, sign-ins waiting and sealed approvals, and leaves every other identity as it was", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    bodyOf(await manage(owner, env).createIdentity("lab-m", "agent"));
    const laptop = await connect("scribe", "laptop");
    const server = await connect("scribe", "server");
    const labs = await connect("lab-m", "lab device");

    // A device that asked and is waiting, and one the owner allowed with a sealed approval it has not collected yet.
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const waiting = bodyOf(await device(null, env).start("scribe", "still waiting", key));
    const allowed = bodyOf(await device(null, env).start("scribe", "allowed not collected", key));
    const sealed = { approval: Buffer.from(crypto.getRandomValues(new Uint8Array(100))).toString("base64"), approverKey: key };
    bodyOf(await device(owner, env).approve(allowed.code, sealed));
    const count = async (table: string, where: string, ...params: string[]): Promise<number> =>
      (await env.NEXUS_DB!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...params).first<{ n: number }>())!.n;
    expect(await count("nexus_approvals", "code = ?", allowed.code), "the sealed approval is kept").toBe(1);

    bodyOf(await vaultAs(laptop.who, env).save(GARDEN_V1, 0));
    expect(bodyOf(await manage(owner, env).removeIdentity("scribe")), "the laptop, the server and the allowed sign-in (approving makes its token at once, before the device collects it) are revoked").toEqual({ result: "removed", name: "scribe", revoked: 3 });

    for (const [who, what] of [[laptop.who, "the laptop"], [server.who, "the server"]] as const) {
      expectRefusal(await vaultAs(who, env).list(), 401, `${what} after its identity was removed`);
    }
    expectRefusal(await device(owner, env).pending(waiting.code), 404, "the sign-in that was waiting");
    expectRefusal(await device(null, env).poll(allowed.secret), 404, "the sign-in that was allowed and not collected");
    expect(await count("nexus_approvals", "code = ?", allowed.code), "the sealed approval is gone").toBe(0);
    expect(await count("nexus_tokens", "identity = ?", "scribe"), "no token row of scribe's is left, revoked or not").toBe(0);
    expect(await count("nexus_signins", "identity = ?", "scribe")).toBe(0);

    expect((await vaultAs(labs.who, env).list()).status, "another identity's device still works").toBe(200);
    expect((await identitiesOf()).find((i) => i.name === "lab-m")!.devices.map((d) => d.id)).toEqual([labs.id]);
    expect(await namesOf()).toEqual([OWNER, "lab-m"]);

    const note = bodyOf(await vaultAs(owner, env).note(GARDEN_V1.id));
    expect(note.writer, "what scribe saved is kept, under the device that saved it").toBe(`device:${laptop.id}`);
  });

  it("lets the same name be made again, with no device from before", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    const before = await connect("scribe", "before");
    bodyOf(await manage(owner, env).removeIdentity("scribe"));
    expect(bodyOf(await manage(owner, env).createIdentity("scribe", "agent"))).toEqual({ name: "scribe", kind: "agent" });
    expect((await identitiesOf()).find((i) => i.name === "scribe")!.devices).toEqual([]);
    expectRefusal(await vaultAs(before.who, env).list(), 401, "the old token of the name made again");
  });

  it("removes an identity that has no device, and refuses it the second time", async () => {
    bodyOf(await manage(owner, env).createIdentity("lab-m", "agent"));
    expect(bodyOf(await manage(owner, env).removeIdentity("lab-m"))).toEqual({ result: "removed", name: "lab-m", revoked: 0 });
    expectRefusal(await manage(owner, env).removeIdentity("lab-m"), 404, "removing it twice");
  });

  it("refuses the owner, an unknown name, a missing or odd name and any other field, and removes nothing", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    const device1 = await connect("scribe", "kept");
    const fetchRemove = (body: unknown) => sendAs("POST", `${API}/identity/remove`, owner, body, env);

    const refusals: Array<[string, unknown, number]> = [
      ["the owner", { name: OWNER }, 403],
      ["a name nobody has", { name: "nobody-here" }, 404],
      ["an extra field", { name: "scribe", force: true }, 400],
      ["an extra field with the owner's name", { name: OWNER, force: true }, 400],
      ["no name", {}, 400],
      ["a name that is not text", { name: 7 }, 400],
      ["an empty name", { name: "" }, 400],
    ];
    for (const [what, body, status] of refusals) {
      const answer = await fetchRemove(body);
      expectRefusal(answer, status, what);
      expect(answer.body.error, `${what}: plain words`).toMatch(/^[A-Z].*\.$/);
    }
    expect((await vaultAs(device1.who, env).list()).status, "scribe's device still works").toBe(200);
    expect(await namesOf()).toEqual([OWNER, "scribe"]);
  });
});

describe("who may call them", () => {
  it("turns nobody and a signed-in stranger away with 401, and every other identity with 403, on both routes", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    bodyOf(await manage(owner, env).createIdentity("lab-m", "agent"));
    const scribe = await connect("scribe", "scribe device");
    const stranger: Who = { cookie: (await signInStranger()).cookie };

    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      expectRefusal(await manage(who, env).identities(), 401, `${what} listing identities`);
      expectRefusal(await manage(who, env).removeIdentity("lab-m"), 401, `${what} removing an identity`);
    }
    // A header that is not a token Nexus made is nobody too.
    expectRefusal(await manage({ bearer: "nx_not-a-token" }, env).identities(), 401, "an unknown token listing identities");
    expectRefusal(await manage({ bearer: "nx_not-a-token" }, env).removeIdentity("lab-m"), 401, "an unknown token removing an identity");

    expectRefusal(await manage(scribe.who, env).identities(), 403, "an agent listing identities");
    expectRefusal(await manage(scribe.who, env).removeIdentity("lab-m"), 403, "an agent removing another identity");
    expectRefusal(await manage(scribe.who, env).removeIdentity("scribe"), 403, "an agent removing itself");
    expectRefusal(await manage(scribe.who, env).removeIdentity(OWNER), 403, "an agent removing the owner");

    expect(await namesOf(), "none of those removed anything").toEqual([OWNER, "lab-m", "scribe"]);
    expect((await vaultAs(scribe.who, env).list()).status, "scribe's device still works").toBe(200);
  });

  it("lets a token made for the owner call both, because it is the owner", async () => {
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    const phone = await connect(OWNER, "owner phone");
    expect(await namesOf(phone.who)).toEqual([OWNER, "scribe"]);
    expect(bodyOf(await manage(phone.who, env).removeIdentity("scribe")).result).toBe("removed");
    expect(await namesOf(phone.who)).toEqual([OWNER]);
  });

  it("lets the owner's secret in the header call them too, as the approval page does", async () => {
    // Over https, as the tests call the Worker (nexus-world.ts ORIGIN).
    bodyOf(await manage(owner, env).createIdentity("scribe", "agent"));
    expect(await namesOf({ ownerSecret: OWNER_SECRET })).toEqual([OWNER, "scribe"]);
  });
});
