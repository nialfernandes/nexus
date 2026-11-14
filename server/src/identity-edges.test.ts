// The edges of identities that the main tests leave alone: who wins when two requests race, which credential counts
// when a request carries two, what the history and the changes feed hide about a move, the limits on a sign-in a
// device starts with no credential, what a list of rights may hold, and which files the approval page's route will
// serve. Through the Nexus Worker (see __fixtures__/identity-world.ts for how a token is got).

import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { ORIGIN, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, issueToken, manage, readWholeFeed, sendAs, tokenFor, vaultAs, type Who } from "./__fixtures__/identity-world";
import { MAX_LABEL, MAX_WAITING } from "./devices";

let ownerCookie: string;
let owner: Who;
let agents: Who;

/** A GET through the Nexus Worker with exactly these headers, so a request can carry a cookie and a token together. */
const rawGet = async (path: string, headers: Record<string, string>): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }), appEnv());

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  agents = tokenFor(() => ownerCookie, "agents", "edge-test agents");
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
  const PRIVATE_NOTE = "/apps/nexus/api/note?path=Private%2Fedge-both.md";

  it("is the identity of the token, not of the cookie beside it", async () => {
    bodyOf(await vaultAs(owner).save("Private/edge-both.md", "private\n"));
    const { token } = await issueToken(ownerCookie, "agents", "edge-both");

    expect((await rawGet(PRIVATE_NOTE, { cookie: ownerCookie })).status, "the cookie alone is owner").toBe(200);
    const withToken = await rawGet(PRIVATE_NOTE, { cookie: ownerCookie, authorization: `Bearer ${token}` });
    expect(withToken.status, "the owner's cookie beside the agents' token is held to the agents' rights").toBe(403);
  });

  it("is turned away when the token is no good, with no falling back to the cookie", async () => {
    const answer = await rawGet(PRIVATE_NOTE, { cookie: ownerCookie, authorization: "Bearer not-a-token-0123456789abcdef0123456789abcdef" });
    expect(answer.status).toBe(401);
  });
});

describe("a body that is not declared as JSON", () => {
  const post = async (path: string, headers: Record<string, string>, body: unknown): Promise<Response> =>
    worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" }), appEnv());

  it("cannot allow a sign-in, even with the owner's cookie, so a page on another site cannot do it for the owner", async () => {
    const sign = bodyOf(await device().start("agents", "edge-cross-site"));
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await post("/apps/nexus/api/device/approve", { cookie: ownerCookie, "content-type": type }, { code: sign.code });
      expect(answer.status, type).toBe(400);
    }
    const noType = await post("/apps/nexus/api/device/approve", { cookie: ownerCookie }, { code: sign.code });
    expect(noType.status, "no content type at all").toBe(400);
    expect(bodyOf(await device().poll(sign.secret)), "nothing was allowed").toMatchObject({ status: "pending" });
    expect(bodyOf(await device(owner).approve(sign.code)).result, "sent as JSON it works").toBe("approved");
  });

  it("is refused by the store's routes too, and keeps nothing", async () => {
    const answer = await post("/apps/nexus/api/save", { cookie: ownerCookie, "content-type": "text/plain" }, { path: "Edge/cross-site.md", text: "x\n" });
    expect(answer.status).toBe(400);
    expectRefusal(await vaultAs(owner).note("Edge/cross-site.md"), 404, "the note the refused save tried to make");
  });
});

describe("what the history and the feed hide about a move", () => {
  it("shows an agent a note moved out of Private/ without saying where it came from", async () => {
    bodyOf(await vaultAs(owner).save("Private/edge-moved.md", "moving out\n"));
    bodyOf(await vaultAs(owner).move("Private/edge-moved.md", "Ideas/edge-moved.md"));

    const history = bodyOf(await vaultAs(agents).history("Ideas/edge-moved.md")).versions;
    expect(history.map((v: { kind: string }) => v.kind)).toEqual(["save", "move"]);
    expect(JSON.stringify(history), "the old name in the history").not.toContain("Private/edge-moved.md");
    expect(JSON.stringify(bodyOf(await vaultAs(owner).history("Ideas/edge-moved.md")).versions), "owner still sees it").toContain("Private/edge-moved.md");

    const feed = await readWholeFeed(agents, 50);
    const move = feed.find((c) => c.path === "Ideas/edge-moved.md");
    expect(move, "the move is in the agents' feed").toBeTruthy();
    expect(JSON.stringify(feed), "the old name in the agents' feed").not.toContain("Private/edge-moved.md");
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

describe("a list of rights", () => {
  it("is refused when a folder has no closing slash, climbs out of the vault, or is named twice", async () => {
    for (const [rights, what] of [
      [[{ path: "Ideas", access: "write" }], "a folder with no closing slash"],
      [[{ path: "../Ideas/", access: "write" }], "a folder that climbs out of the vault"],
      [[{ path: "/Ideas/", access: "write" }], "an absolute folder"],
      [[{ path: "Ideas/", access: "write" }, { path: "Ideas/", access: "read" }], "a folder named twice"],
      [[{ path: 7, access: "write" }], "a path that is not text"],
      [{ path: "Ideas/", access: "write" }, "rights that are not a list"],
    ] as const) {
      expectRefusal(await manage(owner).createIdentity("edge-rights", "agent", rights as never), 400, what);
    }
    expect(bodyOf(await manage(owner).createIdentity("edge-rights", "agent", [{ path: "Ideas/", access: "write" }])).name, "none of the refused ones made it").toBe("edge-rights");
  });

  it("is only ever made for a name of lower case letters, digits and hyphens", async () => {
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
    expect((await sendAs("GET", "/apps/nexus/api/no-such-route", null)).status).toBe(401);
    expect((await sendAs("GET", "/apps/nexus/api/no-such-route", owner)).status).toBe(404);
  });

  it("answers a device route with the wrong method 405, with or without a credential", async () => {
    expect((await sendAs("GET", "/apps/nexus/api/device/start", null)).status).toBe(405);
    expect((await sendAs("GET", "/apps/nexus/api/device/poll", owner)).status).toBe(405);
  });

  it("does not let the two open device routes reach anything else: pending and approve still need the owner", async () => {
    expect((await sendAs("GET", "/apps/nexus/api/device/pending?code=ABCD-EFGH", null)).status).toBe(401);
    expect((await sendAs("POST", "/apps/nexus/api/device/approve", null, { code: "ABCD-EFGH" })).status).toBe(401);
  });
});

describe("the approval page's route", () => {
  it("serves the page and the three files it is made of to the owner, and nothing else under /apps/nexus", async () => {
    for (const path of ["/apps/nexus/approve", "/apps/nexus/approve.css", "/apps/nexus/approve.js", "/apps/nexus/theme-boot.js"]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(200);
    }
    for (const path of ["/apps/nexus/approve.html", "/apps/nexus/", "/apps/nexus/other.js", "/apps/nexus/approve/index.html"]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(404);
    }
  });

  it("is not kept by the browser, because it is for one person at one moment", async () => {
    const res = await rawGet("/apps/nexus/approve?code=ABCD-EFGH", { cookie: ownerCookie });
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
