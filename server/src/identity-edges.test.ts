// The edges of identities that the main tests leave alone: who wins when two requests race, which credential counts
// when a request carries two, the limits on a sign-in a device starts with no credential, what an identity's name may
// be, and which files the pages' route will serve. Through the Nexus Worker (see
// __fixtures__/identity-world.ts for how a token is got).

import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { ORIGIN, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, issueToken, manage, sendAs, vaultAs, writerOf, type Who } from "./__fixtures__/identity-world";
import { MAX_LABEL, MAX_WAITING } from "./devices";

let ownerCookie: string;
let owner: Who;

/** A GET through the Nexus Worker with exactly these headers, so a request can carry a cookie and a token together. */
const rawGet = async (path: string, headers: Record<string, string>): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }), appEnv());

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
});

describe("two requests at once", () => {
  it("hands a token to one poll, and the other is told the code is used", async () => {
    const sign = bodyOf(await device().start("agents", "edge-race-poll"));
    bodyOf(await device(owner).approve(sign.code));

    const answers = await Promise.all([device().poll(sign.secret), device().poll(sign.secret)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 410]);
    const tokens = bodyOf(await manage(owner).tokens()).tokens.filter((t: { label: string }) => t.label === "edge-race-poll");
    expect(tokens, "one sign-in, one token").toHaveLength(1);
  });

  it("lets one answer win when the owner allows and denies the same code together", async () => {
    const sign = bodyOf(await device().start("agents", "edge-race-answer"));
    const answers = await Promise.all([device(owner).approve(sign.code), device(owner).deny(sign.code)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 410]);

    const tokens = bodyOf(await manage(owner).tokens()).tokens.filter((t: { label: string }) => t.label === "edge-race-answer");
    const polled = await device().poll(sign.secret);
    // The token exists exactly when the winner was the allow, and the poll agrees with it.
    expect(polled.status).toBe(tokens.length === 1 ? 200 : 403);
  });
});

describe("a request that carries two credentials", () => {
  /** A save through the Worker with exactly these headers, so a request can carry a cookie and a token together. */
  const saveWith = async (headers: Record<string, string>, id: string): Promise<Response> =>
    worker.fetch(new Request(`${ORIGIN}/nexus/api/save`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id, base: 0, kid: 1, blob: GARDEN_V1.blob }),
      redirect: "manual",
    }), appEnv());

  it("is the identity of the token, not of the cookie beside it", async () => {
    const { token } = await issueToken(ownerCookie, "agents", "edge-both");

    expect((await saveWith({ cookie: ownerCookie }, "edge-cookie")).status, "the cookie alone").toBe(200);
    expect(bodyOf(await vaultAs(owner).note("edge-cookie")).writer, "the cookie alone is owner").toBe("owner");
    expect((await saveWith({ cookie: ownerCookie, authorization: `Bearer ${token}` }, "edge-both")).status).toBe(200);
    expect(bodyOf(await vaultAs(owner).note("edge-both")).writer, "the owner's cookie beside the agents' token is the agents' device").toBe(await writerOf(ownerCookie, "edge-both"));
  });

  it("is turned away when the token is no good, with no falling back to the cookie", async () => {
    const answer = await saveWith({ cookie: ownerCookie, authorization: "Bearer not-a-token-0123456789abcdef0123456789abcdef" }, "edge-bad-token");
    expect(answer.status).toBe(401);
    expectRefusal(await vaultAs(owner).note("edge-bad-token"), 404, "the note the turned-away save tried to make");
  });
});

describe("a body that is not declared as JSON", () => {
  const post = async (path: string, headers: Record<string, string>, body: unknown): Promise<Response> =>
    worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" }), appEnv());

  it("cannot allow a sign-in, even with the owner's cookie, so a page on another site cannot do it for the owner", async () => {
    const sign = bodyOf(await device().start("agents", "edge-cross-site"));
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await post("/nexus/api/device/approve", { cookie: ownerCookie, "content-type": type }, { code: sign.code });
      expect(answer.status, type).toBe(400);
    }
    const noType = await post("/nexus/api/device/approve", { cookie: ownerCookie }, { code: sign.code });
    expect(noType.status, "no content type at all").toBe(400);
    expect(bodyOf(await device().poll(sign.secret)), "nothing was allowed").toMatchObject({ status: "pending" });
    expect(bodyOf(await device(owner).approve(sign.code)).result, "sent as JSON it works").toBe("approved");
  });

  it("is refused by the store's routes too, and keeps nothing", async () => {
    const answer = await post("/nexus/api/save", { cookie: ownerCookie, "content-type": "text/plain" }, { id: "edge-cross-site", base: 0, kid: 1, blob: GARDEN_V1.blob });
    expect(answer.status).toBe(400);
    expectRefusal(await vaultAs(owner).note("edge-cross-site"), 404, "the note the refused save tried to make");
  });
});

describe("a sign-in a device starts with no credential", () => {
  it("is refused for a label longer than the limit, and a label at the limit is kept", async () => {
    expectRefusal(await device().start("agents", "x".repeat(MAX_LABEL + 1)), 400, "a label one over the limit");
    const kept = bodyOf(await device().start("agents", "y".repeat(MAX_LABEL)));
    expect(bodyOf(await device(owner).pending(kept.code)).label).toBe("y".repeat(MAX_LABEL));
  });

  it("is trimmed, so the label the owner is shown is the one the device meant", async () => {
    const sign = bodyOf(await device().start("agents", "  edge-trimmed  "));
    expect(bodyOf(await device(owner).pending(sign.code)).label).toBe("edge-trimmed");
  });
});

describe("an identity's name", () => {
  it("is only ever made of lower case letters, digits and hyphens", async () => {
    for (const name of ["Upper", "has space", "-leading", "a/b", "x".repeat(41)]) {
      expectRefusal(await manage(owner).createIdentity(name, "agent"), 400, `the name ${name}`);
    }
  });
});

describe("the tokens list and revoking", () => {
  it("drops a token once it is revoked, and refuses to revoke it twice", async () => {
    const sign = bodyOf(await device().start("agents", "edge-revoke-twice"));
    bodyOf(await device(owner).approve(sign.code));
    bodyOf(await device().poll(sign.secret));
    const entry = bodyOf(await manage(owner).tokens()).tokens.find((t: { label: string }) => t.label === "edge-revoke-twice");

    expect(bodyOf(await manage(owner).revoke(entry.id)).result).toBe("revoked");
    const after = bodyOf(await manage(owner).tokens()).tokens.map((t: { id: string }) => t.id);
    expect(after).not.toContain(entry.id);
    expectRefusal(await manage(owner).revoke(entry.id), 404, "revoking it again");
  });

  it("turns away a token that nobody allowed: the sign-in's own secret is not a token", async () => {
    const sign = bodyOf(await device().start("agents", "edge-unallowed"));
    expectRefusal(await vaultAs({ bearer: sign.secret }).list(), 401, "the secret used as a token");
    expect(bodyOf(await device().poll(sign.secret))).toMatchObject({ status: "pending" });
  });
});

describe("routes that are not there, and the two a device calls", () => {
  it("tells nobody what routes exist: an unknown route is 401 with no credential and 404 for the owner", async () => {
    expect((await sendAs("GET", "/nexus/api/no-such-route", null)).status).toBe(401);
    expect((await sendAs("GET", "/nexus/api/no-such-route", owner)).status).toBe(404);
  });

  it("answers a device route with the wrong method 405, with or without a credential", async () => {
    expect((await sendAs("GET", "/nexus/api/device/start", null)).status).toBe(405);
    expect((await sendAs("GET", "/nexus/api/device/poll", owner)).status).toBe(405);
  });

  it("does not let the two open device routes reach anything else: pending and approve still need the owner", async () => {
    expect((await sendAs("GET", "/nexus/api/device/pending?code=ABCD-EFGH", null)).status).toBe(401);
    expect((await sendAs("POST", "/nexus/api/device/approve", null, { code: "ABCD-EFGH" })).status).toBe(401);
  });
});

describe("the pages' route", () => {
  it("serves the approval page, the Nexus page and the files they are made of, and nothing else under /nexus", async () => {
    for (const path of [
      "/nexus/approve", "/nexus/approve.css", "/nexus/approve.js", "/nexus/", "/nexus/nexus.css", "/nexus/nexus.js",
      "/nexus/fonts/unbounded-var.woff2", "/nexus/fonts/instrument-sans-var.woff2", "/nexus/fonts/jetbrains-mono-var.woff2",
    ]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(200);
    }
    for (const path of [
      "/nexus/approve.html", "/nexus/index.html", "/nexus/other.js", "/nexus/approve/index.html",
      "/nexus/theme-boot.js", "/nexus/fonts/", "/nexus/fonts/LICENSES.md", "/nexus/fonts/other.woff2",
    ]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(404);
    }
  });

  it("is not kept by the browser, because it is for one person at one moment", async () => {
    const res = await rawGet("/nexus/approve?code=ABCD-EFGH", { cookie: ownerCookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// Last in the file: the flood leaves the waiting list full, and every start after it would be turned away.
describe("a flood of sign-ins", () => {
  it("is turned away with 429 once too many are waiting, and starts again when they are answered", async () => {
    const waiting = [];
    let refused = null;
    for (let i = 0; i < MAX_WAITING + 5 && refused === null; i++) {
      const answer = await device().start("agents", `edge-flood-${i}`);
      if (answer.status === 429) refused = answer;
      else waiting.push(bodyOf(answer).code);
    }
    expect(refused, "a start after the limit").not.toBeNull();
    expectRefusal(refused!, 429, "a flood of sign-ins");

    bodyOf(await device(owner).deny(waiting[0]));
    expect(bodyOf(await device().start("agents", "edge-after-the-flood")).code).toBeTruthy();
  }, 120_000);
});
