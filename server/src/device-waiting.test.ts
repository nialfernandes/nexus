// The owner's list of sign-ins that are still waiting: GET /device/waiting. The approving device (the plugin, boards 14 and 15 of
// docs/design/nexus) shows the labels, one name in its slab or a list to pick from, and then checks the code a person types against the
// key of the one chosen. The list has each sign-in's label, its sign-in code and the public key it sent (null when none), and nothing secret, it answers only the owner, a sign-in
// that was answered or has run out is not on it, and it is not searched by any code. Through the real Worker (see __fixtures__/identity-world.ts for the shape).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { API, bodyOf, expectRefusal, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";
import { device, sendAs, tokenFor, type Who } from "./__fixtures__/identity-world";
import { DEVICE_KEYS } from "./__fixtures__/device-keys";

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
async function listed(...labels: string[]): Promise<Array<{ label: string; code: string; deviceKey: string | null }>> {
  const all = bodyOf(await device(owner).waiting()).signins as Array<{ label: string; code: string; deviceKey: string | null }>;
  return all.filter((s) => labels.includes(s.label));
}

describe("the list of sign-ins that are waiting", () => {
  it("has the label, the sign-in code and the public key (null when none was sent) of each sign-in a device started, oldest first, and nothing else", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    // Started a second apart, so which is older is a fact of the clock and not of luck. The later is started first, so the order of the list is not the order of the codes or the labels either.
    const later = await (async () => { vi.setSystemTime(now + 1000); return started("lab-list-a-later"); })();
    vi.setSystemTime(now - 1000);
    const earlier = await started("lab-list-z-earlier");
    vi.setSystemTime(now + 2000);
    expect(await listed("lab-list-a-later", "lab-list-z-earlier")).toEqual([
      { label: "lab-list-z-earlier", code: earlier.code, deviceKey: null },
      { label: "lab-list-a-later", code: later.code, deviceKey: null },
    ]);
  });

  it("holds nothing secret: every entry has only a label, a sign-in code and a public key, and the device's secret and its token are nowhere in the answer", async () => {
    const sign = await started("lab-leaks-nothing");
    const answer = await device(owner).waiting();
    const entries = bodyOf(answer).signins as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(Object.keys(entry).sort(), "only the label, the code and the public key").toEqual(["code", "deviceKey", "label"]);
    expect(Object.keys(bodyOf(answer)), "nothing but the list").toEqual(["signins"]);
    expect(answer.text).not.toContain(sign.secret);
    // The token the device will be handed is worked out from its secret: it is not in the answer either.
    expect(answer.text).not.toMatch(/nx_[0-9a-f]{16}/);
  });

  it("carries the public key a device sent, as it sent it, and null for one that sent none; and no code worked out from it", async () => {
    const keyed = bodyOf(await device().start("agents", "lab-list-keyed", DEVICE_KEYS[1]!.key)) as { code: string };
    const keyless = await started("lab-list-keyless");
    const answer = await device(owner).waiting();
    expect(await listed("lab-list-keyed", "lab-list-keyless")).toEqual([
      { label: "lab-list-keyed", code: keyed.code, deviceKey: DEVICE_KEYS[1]!.key },
      { label: "lab-list-keyless", code: keyless.code, deviceKey: null },
    ]);
    expect(answer.text, "the key code is not in the list: whoever reads the list works it out from the key").not.toContain(DEVICE_KEYS[1]!.code);
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
    expect(await listed("lab-gone-fresh"), "a later sign-in is still waiting").toEqual([{ label: "lab-gone-fresh", code: fresh.code, deviceKey: null }]);
  });
});

describe("the list is not searched by a code", () => {
  it("is the whole list whatever is put in the address: no code narrows it, so the approving device shows the labels and picks one itself", async () => {
    const mine = await started("lab-find-mine");
    await started("lab-find-other");
    const labels = (answer: { body: { signins?: Array<{ label: string }> } }) => (answer.body.signins ?? []).map((s) => s.label);
    const whole = labels(await device(owner).waiting());
    expect(whole).toEqual(expect.arrayContaining(["lab-find-mine", "lab-find-other"]));
    const asked = await sendAs("GET", `${API}/device/waiting?code=${encodeURIComponent(mine.code)}`, owner);
    expect(labels(asked), "a code in the address changes nothing").toEqual(whole);
  });
});

describe("only the owner is let see the list", () => {
  it("is 403 for an identity that is not the owner, and the answer holds no list", async () => {
    const sign = await started("lab-not-for-agents");
    const answer = await device(agents).waiting();
    expectRefusal(answer, 403, "an agent asking for the list");
    expect(answer.body.signins).toBeUndefined();
    expect(answer.text).not.toContain(sign.code);
  });

  it("is 401 for nobody and for a session that is not the owner's, with no list", async () => {
    const sign = await started("lab-not-for-strangers");
    for (const [who, what] of [[null, "nobody"], [stranger, "a stranger"]] as const) {
      const answer = await device(who).waiting();
      expectRefusal(answer, 401, what);
      expect(answer.text).not.toContain(sign.code);
    }
  });
});
