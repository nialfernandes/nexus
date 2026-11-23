// The owner proves who they are with the owner secret in a request header, which is what the approval page does for a first
// device when no browser has the owner's cookie (a script cannot set a cookie header, and the page keeps no cookie). The
// header is compared exactly as the cookie is (by hash), it is taken over https only, a wrong one is no credential at all, and
// nothing about it is kept: no cookie is set and the secret is in no row of Nexus's database.
//
// The page itself is for anyone who is sent the link: it holds nothing private, and every call it makes is checked here.

import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { API, OWNER_SECRET, appEnv, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { OWNER_SECRET_HEADER, device, everythingStored, manage, sendAs, type Who } from "./__fixtures__/identity-world";

let ownerCookie: string;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
});

const secret = (value: string): Who => ({ ownerSecret: value });

/** One request to an address of the test's choosing (http or https), with the headers it names, straight to the Worker. */
async function raw(address: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  const res = await worker.fetch(
    new Request(address, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }),
    appEnv(),
  );
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("the owner secret in the header", () => {
  it("is the owner: it can do what only the owner can, with no cookie", async () => {
    expect(bodyOf(await manage(secret(OWNER_SECRET)).tokens())).toHaveProperty("tokens");
    const sign = bodyOf(await device().start("agents", "lab-secret-header"));
    expect(bodyOf(await device(secret(OWNER_SECRET)).pending(sign.code))).toMatchObject({ label: "lab-secret-header" });
    expect(bodyOf(await device(secret(OWNER_SECRET)).approve(sign.code))).toMatchObject({ result: "approved", label: "lab-secret-header" });
    expect(bodyOf(await device().poll(sign.secret))).toMatchObject({ status: "approved", label: "lab-secret-header" });
  });

  it("is not the owner when it is wrong: a plain 401 for a wrong secret, a short one and an empty one, and nothing is allowed", async () => {
    const sign = bodyOf(await device().start("agents", "lab-wrong-secret"));
    for (const wrong of [`${OWNER_SECRET}x`, OWNER_SECRET.slice(0, -1), "b".repeat(64), "short", ""]) {
      expectRefusal(await device(secret(wrong)).approve(sign.code), 401, `the secret "${wrong.slice(0, 8)}..."`);
      expectRefusal(await device(secret(wrong)).pending(sign.code), 401, "pending with a wrong secret");
      expectRefusal(await device(secret(wrong)).waiting(), 401, "the list with a wrong secret");
    }
    expect(bodyOf(await device().poll(sign.secret)), "nothing was allowed").toMatchObject({ status: "pending" });
  });

  it("decides on its own when it is sent: a wrong secret is refused even beside a cookie that is right", async () => {
    const answer = await raw("https://nexus.example.test/nexus/api/tokens", { cookie: ownerCookie, [OWNER_SECRET_HEADER]: "wrong" });
    expect(answer.status).toBe(401);
  });

  it("is taken over https only: over plain http it is no credential, though a loopback address (a browser's own secure context) may use it", async () => {
    const path = `${API}/tokens`;
    expect((await raw(`https://nexus.example.test${path}`, { [OWNER_SECRET_HEADER]: OWNER_SECRET })).status).toBe(200);
    const plain = await raw(`http://nexus.example.test${path}`, { [OWNER_SECRET_HEADER]: OWNER_SECRET });
    expect(plain.status, "the secret over plain http").toBe(401);
    expect(plain.text).not.toContain(OWNER_SECRET);
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect((await raw(`${local}${path}`, { [OWNER_SECRET_HEADER]: OWNER_SECRET })).status, local).toBe(200);
    }
  });

  it("is taken over https only in the cookie too: the owner's cookie over plain http to another host is no credential, at a loopback address it is", async () => {
    const path = `${API}/tokens`;
    expect((await raw(`https://nexus.example.test${path}`, { cookie: ownerCookie })).status, "the cookie over https").toBe(200);
    const plain = await raw(`http://nexus.example.test${path}`, { cookie: ownerCookie });
    expect(plain.status, "the cookie over plain http to another host").toBe(401);
    expect(plain.text).not.toContain(OWNER_SECRET);
    expect((await raw(`http://192.168.1.20:8787${path}`, { cookie: ownerCookie })).status, "nor to a network address").toBe(401);
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect((await raw(`${local}${path}`, { cookie: ownerCookie })).status, local).toBe(200);
    }
    // Nothing the owner can do is done with it over plain http: a sign-in stays waiting.
    const sign = bodyOf(await device().start("agents", "lab-cookie-plain-http"));
    const refused = await raw(`http://nexus.example.test${API}/device/approve`, { cookie: ownerCookie }, "POST", { code: sign.code });
    expect(refused.status).toBe(401);
    expect(bodyOf(await device().poll(sign.secret)), "nothing was allowed").toMatchObject({ status: "pending" });
  });

  it("is kept nowhere: no cookie is set, it is not in any answer, and it is in no row of the database", async () => {
    const sign = bodyOf(await device().start("agents", "lab-secret-kept-nowhere"));
    const answers = [
      await raw(`https://nexus.example.test${API}/device/pending?code=${sign.code}`, { [OWNER_SECRET_HEADER]: OWNER_SECRET }),
      await raw(`https://nexus.example.test${API}/device/approve`, { [OWNER_SECRET_HEADER]: OWNER_SECRET }, "POST", { code: sign.code }),
      await raw(`https://nexus.example.test${API}/device/pending?code=${sign.code}`, { [OWNER_SECRET_HEADER]: "wrong" }),
    ];
    for (const answer of answers) {
      expect(answer.headers.get("set-cookie"), "no cookie is set").toBeNull();
      expect(answer.text).not.toContain(OWNER_SECRET);
    }
    expect(await everythingStored(), "the secret is in no row").not.toContain(OWNER_SECRET);
  });
});

describe("the pages and their files, for a browser that is not signed in", () => {
  it("are served to anyone: the approval page and the Nexus page, their scripts and stylesheets and the three typefaces hold nothing private", async () => {
    for (const path of [
      "/nexus/approve", "/nexus/approve.css", "/nexus/approve.js", "/nexus/", "/nexus/nexus.css", "/nexus/nexus.js",
      "/nexus/fonts/unbounded-var.woff2", "/nexus/fonts/instrument-sans-var.woff2", "/nexus/fonts/jetbrains-mono-var.woff2",
    ]) {
      expect((await sendAs("GET", path, null)).status, `${path} with no sign-in`).toBe(200);
    }
  });

  it("serves nothing else under /nexus to anyone, and every call the page makes still needs the owner", async () => {
    for (const path of ["/nexus/approve.html", "/nexus/index.html", "/nexus/fonts/", "/nexus/fonts/LICENSES.md", "/nexus/fonts/unbounded-OFL.txt"]) {
      expect((await sendAs("GET", path, null)).status, `${path} with no sign-in`).toBe(404);
    }
    const sign = bodyOf(await device().start("agents", "lab-page-for-anyone"));
    expectRefusal(await device(null).pending(sign.code), 401, "pending with no sign-in");
    expectRefusal(await device(null).approve(sign.code), 401, "approve with no sign-in");
    expect(bodyOf(await device().poll(sign.secret)), "nothing was allowed").toMatchObject({ status: "pending" });
  });
});
