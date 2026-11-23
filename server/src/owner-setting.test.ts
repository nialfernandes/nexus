// What the owner and address settings do to a running Nexus, and how the Cloudflare plug lets the owner in: the
// owner's secret, in the cookie `nexus_owner`. Through the Nexus Worker (plugs/cloudflare/worker.ts), each test with a
// world of its own, so each can change what the Worker is told.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_COOKIE } from "./plugs/cloudflare/signin";
import { API, EVERY_ROUTE, OWNER_SECRET, bodyOf, expectRefusal, nexusEnv, send } from "./__fixtures__/nexus-world";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { device, manage, sendAs, vaultAs } from "./__fixtures__/identity-world";

afterEach(() => vi.restoreAllMocks());

const ownersCookie = `${OWNER_COOKIE}=${OWNER_SECRET}`;

describe("with no owner set, which is the default", () => {
  it("is closed: the right secret in the cookie is still nobody, on every route", async () => {
    const env = await nexusEnv({ NEXUS_OWNER: undefined });
    for (const route of EVERY_ROUTE) {
      const answer = await send(route.method, route.path, ownersCookie, route.body, env);
      expect(answer.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it("cannot be opened by naming the owner in the request: nothing in a request says who the owner is", async () => {
    const env = await nexusEnv({ NEXUS_OWNER: undefined });
    const answer = await send("POST", `${API}/identity`, ownersCookie, { name: "agents", kind: "agent" }, env);
    expect(answer.status).toBe(401);
  });

  it("is not the address's job to be the owner: no address set means the address a request came to", async () => {
    const env = await nexusEnv({ NEXUS_ADDRESS: undefined });
    const started = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "owner", label: "no address" }, env));
    expect(started.link.startsWith("https://nexus.example.test/nexus/approve?code=")).toBe(true);
  });
});

describe("with an owner set", () => {
  it("is that name, whatever it is: the cookie signs in as it, what it saves is written by it, and its name cannot be made again", async () => {
    const env = await nexusEnv({ NEXUS_OWNER: "alice" });
    const alice = { cookie: ownersCookie };
    expect(bodyOf(await vaultAs(alice, env).save(GARDEN_V1, 0))).toMatchObject({ result: "saved" });
    expect(bodyOf(await sendAs("GET", `${API}/note?id=${GARDEN_V1.id}`, alice, undefined, env))).toMatchObject({ writer: "alice" });
    expectRefusal(await manage(alice, env).createIdentity("alice", "person"), 409, "making the owner's name again");
  });

  it("is closed to a cookie when there is no secret: the owner's name alone lets nobody in", async () => {
    const env = await nexusEnv({ NEXUS_OWNER_SECRET: undefined });
    for (const cookie of [ownersCookie, `${OWNER_COOKIE}=`, `${OWNER_COOKIE}=undefined`]) {
      expect((await send("GET", `${API}/list`, cookie, undefined, env)).status, cookie).toBe(401);
    }
  });

  it("finds the cookie among others, and only by its own name", async () => {
    const env = await nexusEnv();
    const list = (cookie: string) => send("GET", `${API}/list`, cookie, undefined, env);
    expect((await list(`theme=dark; ${ownersCookie}; lang=en`)).status).toBe(200);
    expect((await list(`x${ownersCookie}`)).status, "a cookie whose name only ends in the right one").toBe(401);
    expect((await list(`other=${ownersCookie}`)).status, "the secret inside another cookie's value").toBe(401);
    expect((await list(`${OWNER_COOKIE}=${OWNER_SECRET.slice(0, -1)}`)).status, "all but the last character").toBe(401);
    expect((await list(`${OWNER_COOKIE}=${OWNER_SECRET}x`)).status, "the secret and one more character").toBe(401);
  });
});

describe("a setting that cannot be used", () => {
  /** Silences the log line the Worker writes, and hands back what it wrote. */
  const logged = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("stops every request with a plain 503, and the log says which variable is wrong, never the answer", async () => {
    const log = logged();
    for (const [what, settings] of [
      ["an owner name that is not a name", { NEXUS_OWNER: "Not A Name" }],
      ["an address that is not a web address", { NEXUS_ADDRESS: "nexus.example.org" }],
      ["a secret that is too short to be one", { NEXUS_OWNER_SECRET: "short" }],
    ] as const) {
      const env = await nexusEnv(settings);
      const answer = await send("GET", `${API}/list`, ownersCookie, undefined, env);
      expect(answer.status, what).toBe(503);
      expect(answer.text, what).not.toMatch(/NEXUS_|short|Not A Name/);
    }
    const written = log.mock.calls.map((call) => String(call[1])).join("\n");
    expect(written).toMatch(/NEXUS_OWNER has to be/);
    expect(written).toMatch(/NEXUS_ADDRESS has to be/);
    expect(written).toMatch(/NEXUS_OWNER_SECRET has to be at least 32 characters/);
  });
});

describe("the address", () => {
  it("is what the approval link is built on when it is set, and a path on it is left off", async () => {
    const env = await nexusEnv({ NEXUS_ADDRESS: "https://nexus.example.org/ignored/path" });
    const started = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "owner", label: "set address" }, env));
    expect(started.link).toBe(`https://nexus.example.org/nexus/approve?code=${encodeURIComponent(started.code)}`);
  });

  it("does not change where the Worker answers: the routes are the same on any address", async () => {
    const env = await nexusEnv({ NEXUS_ADDRESS: "https://nexus.example.org" });
    expect((await send("GET", `${API}/list`, ownersCookie, undefined, env)).status).toBe(200);
  });
});

describe("the owner's first sign-in for a device", () => {
  it("makes the owner's name a row on the way, so a token can be made for it, and does it once", async () => {
    const env = await nexusEnv();
    const first = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "owner", label: "first" }, env));
    const second = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "owner", label: "second" }, env));
    const rows = await env.NEXUS_DB!.prepare("SELECT name, kind FROM nexus_identities WHERE name = 'owner'").all();
    expect(rows.results).toEqual([{ name: "owner", kind: "person" }]);

    bodyOf(await device({ cookie: ownersCookie }, env).approve(first.code));
    const polled = bodyOf(await device(null, env).poll(first.secret));
    expect(polled).toMatchObject({ status: "approved", identity: "owner" });
    expect(typeof second.code).toBe("string");
  });

  it("does not make a row for any other name: an identity that is not there is still not found", async () => {
    const env = await nexusEnv();
    expectRefusal(await sendAs("POST", `${API}/device/start`, null, { identity: "nobody-here", label: "x" }, env), 404, "an unknown identity");
    const rows = await env.NEXUS_DB!.prepare("SELECT name FROM nexus_identities").all();
    expect(rows.results).toEqual([]);
  });
});

describe("the Worker's own addresses", () => {
  it("answers 404 in plain words to an address that is not Nexus's, and sends the approval page and the Nexus page to anyone who opens them, since they hold nothing private", async () => {
    const env = await nexusEnv();
    for (const path of ["/", "/nexus", "/nexus/other", "/apps/nexus", "/apps/other", "/favicon.ico"]) {
      const answer = await send("GET", path, ownersCookie, undefined, env);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toBeNull();
    }
    expect((await send("GET", "/nexus/approve", null, undefined, env)).status, "the page is for anyone with its link: the owner signs in on it").toBe(200);
    expect((await send("GET", "/nexus/", null, undefined, env)).status, "the Nexus page is for anyone too: the owner signs in on it").toBe(200);
    expect((await send("POST", "/nexus/approve", ownersCookie, {}, env)).status, "only a GET opens the page").toBe(404);
    expect((await send("POST", "/nexus/", ownersCookie, {}, env)).status, "only a GET opens the Nexus page").toBe(404);
  });
});
