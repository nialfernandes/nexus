// The owner's list of sign-ins that are still waiting: GET /device/waiting. The approving device (a plugin that has only the
// code a person typed from the new device's screen, boards 14 and 15 of docs/design/nexus) finds the sign-in from that code
// alone. The list has each sign-in's label and device code and nothing secret, it answers only the owner, and a sign-in
// that was answered or has run out is not on it. Through the real Worker (see __fixtures__/identity-world.ts for the shape).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { device, tokenFor, type Who } from "./__fixtures__/identity-world";

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

async function started(label: string) {
  return bodyOf(await device().start("agents", label)) as { code: string; link: string; secret: string; expiresAt: number };
}

/** What the owner's list holds for these labels, in order. */
async function listed(...labels: string[]): Promise<Array<{ label: string; code: string }>> {
  const all = bodyOf(await device(owner).waiting()).signins as Array<{ label: string; code: string }>;
  return all.filter((s) => labels.includes(s.label));
}

describe("the list of sign-ins that are waiting", () => {
  it("has the label and the device code of each sign-in a device started, oldest first, and nothing else", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    // Started a second apart, so which is older is a fact of the clock and not of luck. The later is started first, so the order of the list is not the order of the codes or the labels either.
    const later = await (async () => { vi.setSystemTime(now + 1000); return started("lab-list-a-later"); })();
    vi.setSystemTime(now - 1000);
    const earlier = await started("lab-list-z-earlier");
    vi.setSystemTime(now + 2000);
    expect(await listed("lab-list-a-later", "lab-list-z-earlier")).toEqual([
      { label: "lab-list-z-earlier", code: earlier.code },
      { label: "lab-list-a-later", code: later.code },
    ]);
  });

  it("holds nothing secret: every entry has only a label and a code, and the device's secret and its token are nowhere in the answer", async () => {
    const sign = await started("lab-leaks-nothing");
    const answer = await device(owner).waiting();
    const entries = bodyOf(answer).signins as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(Object.keys(entry).sort(), "only the label and the code").toEqual(["code", "label"]);
    expect(Object.keys(bodyOf(answer)), "nothing but the list").toEqual(["signins"]);
    expect(answer.text).not.toContain(sign.secret);
    // The token the device will be handed is worked out from its secret: it is not in the answer either.
    expect(answer.text).not.toMatch(/nx_[0-9a-f]{16}/);
  });

  it("drops a sign-in once it is allowed, once it is denied, and once its ten minutes are up", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const allowed = await started("lab-gone-allowed");
    const denied = await started("lab-gone-denied");
    const late = await started("lab-gone-late");
    const stays = await started("lab-gone-stays");
    expect((await listed("lab-gone-allowed", "lab-gone-denied", "lab-gone-late", "lab-gone-stays")).map((s) => s.label)).toHaveLength(4);

    bodyOf(await device(owner).approve(allowed.code));
    bodyOf(await device(owner).deny(denied.code));
    expect((await listed("lab-gone-allowed", "lab-gone-denied")), "answered").toEqual([]);

    vi.setSystemTime(now + TEN_MINUTES - 1000);
    const fresh = await started("lab-gone-fresh");
    expect((await listed("lab-gone-late", "lab-gone-stays")).map((s) => s.code).sort(), "not yet run out").toEqual([late.code, stays.code].sort());
    vi.setSystemTime(now + TEN_MINUTES + 1000);
    expect(await listed("lab-gone-late", "lab-gone-stays"), "run out").toEqual([]);
    expect(await listed("lab-gone-fresh"), "a later sign-in is still waiting").toEqual([{ label: "lab-gone-fresh", code: fresh.code }]);
  });
});

describe("finding one sign-in from its device code", () => {
  it("gives the sign-in that code is, and only that one", async () => {
    const mine = await started("lab-find-mine");
    await started("lab-find-other");
    const found = bodyOf(await device(owner).waiting(mine.code));
    expect(found.signins).toEqual([{ label: "lab-find-mine", code: mine.code }]);
  });

  it("finds it however a person types the code: small letters, spaces, no dash", async () => {
    const mine = await started("lab-find-typed");
    const plain = mine.code.replace("-", "");
    for (const typed of [mine.code.toLowerCase(), plain, plain.toLowerCase(), `${plain.slice(0, 4)} ${plain.slice(4)}`.toLowerCase(), ` ${mine.code} `]) {
      expect(bodyOf(await device(owner).waiting(typed)).signins, `typed as "${typed}"`).toEqual([{ label: "lab-find-typed", code: mine.code }]);
    }
  });

  it("gives an empty list, not an error, for a code no waiting sign-in has, and for one already answered", async () => {
    const answered = await started("lab-find-answered");
    bodyOf(await device(owner).approve(answered.code));
    expect(bodyOf(await device(owner).waiting("ZZZZ-ZZZZ"))).toEqual({ signins: [] });
    expect(bodyOf(await device(owner).waiting(answered.code))).toEqual({ signins: [] });
    expect(bodyOf(await device(owner).waiting("---")), "a code with nothing in it finds nothing, not everything").toEqual({ signins: [] });
  });
});

describe("only the owner is let see the list", () => {
  it("is 403 for an identity that is not the owner, and the answer holds no list", async () => {
    const sign = await started("lab-not-for-agents");
    const answer = await device(agents).waiting();
    expectRefusal(answer, 403, "an agent asking for the list");
    expect(answer.body.signins).toBeUndefined();
    expect(answer.text).not.toContain(sign.code);
    const byCode = await device(agents).waiting(sign.code);
    expectRefusal(byCode, 403, "an agent finding a sign-in from its code");
    expect(byCode.text).not.toContain("lab-not-for-agents");
  });

  it("is 401 for nobody and for a session that is not the owner's, with no list", async () => {
    const sign = await started("lab-not-for-strangers");
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      const answer = await device(who).waiting(sign.code);
      expectRefusal(answer, 401, what);
      expect(answer.text).not.toContain(sign.code);
    }
  });
});
