// Device approval: how an agent's command or a plugin gets a token without a secret ever being pasted anywhere.
// The device asks Nexus to start a sign-in for an identity and a label and is handed a short code and a link. The
// owner, signed in, opens the link and allows or denies it. The device, polling, is handed its token once. A code
// lasts ten minutes and works once, and only the owner can allow it. Through the Nexus Worker (see
// __fixtures__/identity-world.ts for the shape of every answer). The page the owner sees is approval-page.test.ts.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ORIGIN, bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { device, manage, tokenFor, vaultAs, type Who } from "./__fixtures__/identity-world";

const TEN_MINUTES = 10 * 60 * 1000;

let ownerCookie: string;
let owner: Who;
let stranger: Who;
let agents: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  stranger = { cookie: (await signInStranger()).cookie };
  agents = tokenFor(() => ownerCookie, "agents", "the agents' own device");
});

afterEach(() => {
  vi.useRealTimers();
});

/** A sign-in the device has started, ready for the owner to answer. */
async function started(label: string, identity = "agents") {
  return bodyOf(await device().start(identity, label)) as { code: string; link: string; secret: string; expiresAt: number };
}

const tokensLabelled = async (label: string): Promise<unknown[]> =>
  bodyOf(await manage(owner).tokens()).tokens.filter((t: { label: string }) => t.label === label);

describe("a device starts a sign-in", () => {
  it("is handed a short code, a link to the approval page, a long secret of its own and a ten minute expiry", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    const answer = await started("lab-m");
    expect(answer.code).toMatch(/^[A-Za-z0-9-]{4,16}$/);
    expect(answer.link).toBe(`${ORIGIN}/apps/nexus/approve?code=${encodeURIComponent(answer.code)}`);
    expect(answer.secret.length).toBeGreaterThanOrEqual(32);
    expect(answer.secret, "the code is on a phone's screen; the secret must not be the code").not.toBe(answer.code);
    expect(answer.expiresAt).toBe(now + TEN_MINUTES);
  });

  it("needs no credential, and gives every start a code and a secret of its own", async () => {
    const one = await started("lab-one");
    const two = await started("lab-two");
    expect(one.code).not.toBe(two.code);
    expect(one.secret).not.toBe(two.secret);
  });

  it("is refused for an identity that does not exist, and for a label that is missing or blank", async () => {
    expectRefusal(await device().start("nobody-by-this-name", "lab-m"), 404, "an unknown identity");
    expectRefusal(await device().start("agents", ""), 400, "a blank label");
    expectRefusal(await device().start("agents", "   "), 400, "a label of spaces");
  });

  it("gives nothing away before the owner answers: the device is told to wait, with no token", async () => {
    const sign = await started("lab-waiting");
    for (let i = 0; i < 2; i++) {
      const polled = bodyOf(await device().poll(sign.secret));
      expect(polled).toMatchObject({ status: "pending" });
      expect(polled.token, "no token before the owner answers").toBeUndefined();
    }
    expect(await tokensLabelled("lab-waiting")).toEqual([]);
  });
});

describe("the owner allows a sign-in and the device is handed its token once", () => {
  it("shows the owner what is being asked, allows it, and the device's next poll is handed a working token", async () => {
    const sign = await started("lab-m");
    expect(bodyOf(await device(owner).pending(sign.code))).toMatchObject({
      code: sign.code, identity: "agents", label: "lab-m", expiresAt: sign.expiresAt,
    });

    expect(bodyOf(await device(owner).approve(sign.code))).toMatchObject({
      result: "approved", code: sign.code, identity: "agents", label: "lab-m",
    });

    const polled = bodyOf(await device().poll(sign.secret));
    expect(polled).toMatchObject({ status: "approved", identity: "agents", label: "lab-m" });
    expect(typeof polled.token).toBe("string");
    expect(polled.token.length).toBeGreaterThanOrEqual(32);

    expect(bodyOf(await vaultAs({ bearer: polled.token }).save("Device/first.md", "from a device\n"))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note("Device/first.md"))).toMatchObject({ writer: "agents" });
    expect(await tokensLabelled("lab-m")).toHaveLength(1);
  });

  it("hands the token over once: the next poll fails and carries no token", async () => {
    const sign = await started("lab-once");
    bodyOf(await device(owner).approve(sign.code));
    const first = bodyOf(await device().poll(sign.secret));
    expect(first.token).toBeTruthy();

    const second = await device().poll(sign.secret);
    expectRefusal(second, 410, "a second poll");
    expect(second.text).not.toContain(first.token);
    expectRefusal(await device().poll(sign.secret), 410, "a third poll");
    expect(await tokensLabelled("lab-once"), "one sign-in, one token").toHaveLength(1);
  });

  it("works once: a code that has been allowed cannot be allowed, denied or opened again", async () => {
    const sign = await started("lab-single-use");
    bodyOf(await device(owner).approve(sign.code));
    expectRefusal(await device(owner).approve(sign.code), 410, "approving again");
    expectRefusal(await device(owner).deny(sign.code), 410, "denying after allowing");
    expectRefusal(await device(owner).pending(sign.code), 410, "opening it again");
    expect(await tokensLabelled("lab-single-use"), "no second token").toHaveLength(1);
  });

  it("is not collected by the short code: only the device's own secret gets the token", async () => {
    const sign = await started("lab-code-only");
    bodyOf(await device(owner).approve(sign.code));
    expectRefusal(await device().poll(sign.code), 404, "a poll made with the code");
    expect(bodyOf(await device().poll(sign.secret)).status).toBe("approved");
  });

  it("is refused for a code nobody was given", async () => {
    expectRefusal(await device(owner).approve("NOSUCHCODE"), 404, "approving an unknown code");
    expectRefusal(await device(owner).deny("NOSUCHCODE"), 404, "denying an unknown code");
    expectRefusal(await device(owner).pending("NOSUCHCODE"), 404, "opening an unknown code");
    expectRefusal(await device().poll("no-such-secret-0123456789abcdef0123456789"), 404, "polling an unknown secret");
  });
});

describe("the owner denies a sign-in", () => {
  it("tells the device no, with no token, now and every time it asks again", async () => {
    const sign = await started("lab-denied");
    expect(bodyOf(await device(owner).deny(sign.code))).toMatchObject({
      result: "denied", code: sign.code, identity: "agents", label: "lab-denied",
    });

    expectRefusal(await device().poll(sign.secret), 403, "the poll after the sign-in was denied");
    expectRefusal(await device().poll(sign.secret), 403, "the poll after that");
    expectRefusal(await device(owner).pending(sign.code), 410, "opening a denied code");
    expect(await tokensLabelled("lab-denied")).toEqual([]);
  });

  it("cannot be turned into an allow afterwards", async () => {
    const sign = await started("lab-denied-then");
    bodyOf(await device(owner).deny(sign.code));
    expectRefusal(await device(owner).approve(sign.code), 410, "allowing a denied code");
    expectRefusal(await device().poll(sign.secret), 403, "the poll");
    expect(await tokensLabelled("lab-denied-then")).toEqual([]);
  });
});

describe("a code lasts ten minutes", () => {
  it("can still be allowed a second before the ten minutes are up", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sign = await started("lab-just-in-time");

    vi.setSystemTime(now + TEN_MINUTES - 1000);
    expect(bodyOf(await device(owner).pending(sign.code)).label).toBe("lab-just-in-time");
    expect(bodyOf(await device(owner).approve(sign.code)).result).toBe("approved");
    expect(bodyOf(await device().poll(sign.secret)).status).toBe("approved");
  });

  it("is dead after ten minutes: it cannot be opened or allowed, and the device is told it expired", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sign = await started("lab-too-late");

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    expectRefusal(await device(owner).pending(sign.code), 410, "opening an expired code");
    expectRefusal(await device(owner).approve(sign.code), 410, "allowing an expired code");
    expectRefusal(await device().poll(sign.secret), 410, "polling an expired code");
    expect(await tokensLabelled("lab-too-late")).toEqual([]);
  });

  it("is dead after ten minutes even when it was allowed in time and the device never collected the token", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sign = await started("lab-never-collected");
    bodyOf(await device(owner).approve(sign.code));

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    const polled = await device().poll(sign.secret);
    expectRefusal(polled, 410, "polling an allowed code after it expired");
    expect(polled.text).not.toContain('"token"');
  });
});

describe("only the owner can answer a sign-in", () => {
  it("turns away a request with no credential, and someone signed in who is not the owner", async () => {
    const sign = await started("lab-not-owner");
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      expectRefusal(await device(who).approve(sign.code), 401, `${what} allowing`);
      expectRefusal(await device(who).deny(sign.code), 401, `${what} denying`);
      const peek = await device(who).pending(sign.code);
      expectRefusal(peek, 401, `${what} opening the code`);
      expect(peek.text, "what is being asked is not given away").not.toContain("lab-not-owner");
    }
    expect(bodyOf(await device().poll(sign.secret))).toMatchObject({ status: "pending" });
  });

  it("turns away another identity's token with 403, so an agent cannot allow its own sign-in", async () => {
    const sign = await started("lab-self-approve");
    const approved = await device(agents).approve(sign.code);
    expectRefusal(approved, 403, "the agents allowing a sign-in");
    expectRefusal(await device(agents).deny(sign.code), 403, "the agents denying one");
    const peek = await device(agents).pending(sign.code);
    expectRefusal(peek, 403, "the agents opening one");
    expect(peek.text).not.toContain("lab-self-approve");

    expect(bodyOf(await device().poll(sign.secret)), "nothing was decided").toMatchObject({ status: "pending" });
    expect(await tokensLabelled("lab-self-approve")).toEqual([]);
  });

  it("leaves the code alive for the owner after someone else's attempt", async () => {
    const sign = await started("lab-still-alive");
    expectRefusal(await device(stranger).approve(sign.code), 401, "a stranger's attempt");
    expectRefusal(await device(agents).approve(sign.code), 403, "an agent's attempt");
    expect(bodyOf(await device(owner).approve(sign.code)).result).toBe("approved");
    expect(bodyOf(await device().poll(sign.secret)).status).toBe("approved");
  });

  it("lets a token made for owner answer, because it is the owner's own", async () => {
    const phone: Who = tokenFor(() => ownerCookie, "owner", "the owner's other phone");
    const sign = await started("lab-from-the-phone");
    expect(bodyOf(await device(phone).approve(sign.code)).result).toBe("approved");
  });
});
