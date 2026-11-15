// A device's public key and the sealed approval the owner's device leaves for it. The new device sends its public key when it
// starts a sign-in; the owner's device, which holds the vault key, answers the allow with the vault key sealed to that key and
// its own public key for the approval; the server keeps both, cannot open them, hands them to the new device in the same first
// poll that hands over the token, and deletes them as it does: once collected, or when the sign-in has run out. The server
// holds no encryption library, so the bytes here are made up: all it checks is their base64 and their size.
// Through the Nexus Worker (see __fixtures__/identity-world.ts for the shape of every answer).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bodyOf, expectRefusal, nexusDb, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, manage, tokenFor, vaultAs, writerOf, type Who } from "./__fixtures__/identity-world";
import { MAX_APPROVAL_BYTES } from "./devices";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";

const TEN_MINUTES = 10 * 60 * 1000;

let ownerCookie: string;
let owner: Who;
let agents: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  agents = tokenFor(() => ownerCookie, "agents", "device-keys agents");
});

afterEach(() => {
  vi.useRealTimers();
});

const b64 = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64");

/** A sign-in started with a public key, as a new device does. */
async function started(label: string, deviceKey: string | null = b64(32)) {
  const answer = bodyOf(await device().start("agents", label, deviceKey ?? undefined)) as { code: string; secret: string; expiresAt: number };
  return { ...answer, deviceKey };
}

/** What the owner's device leaves with its allow. */
const sealed = () => ({ approval: b64(100), approverKey: b64(32) });

/** How many sealed approvals the server holds, for one sign-in's code or (with none) for every sign-in. */
const approvalsStored = async (code?: string): Promise<number> =>
  (await (code === undefined
    ? nexusDb()!.prepare("SELECT COUNT(*) AS n FROM nexus_approvals")
    : nexusDb()!.prepare("SELECT COUNT(*) AS n FROM nexus_approvals WHERE code = ?").bind(code)
  ).first<{ n: number }>())!.n;

describe("a device sends its public key when it starts", () => {
  it("is shown to the owner's device that is asked to approve it, and is null for a sign-in that sent none", async () => {
    const withKey = await started("keyed device");
    expect(bodyOf(await device(owner).pending(withKey.code))).toMatchObject({ code: withKey.code, label: "keyed device", deviceKey: withKey.deviceKey });
    const without = await started("unkeyed device", null);
    expect(bodyOf(await device(owner).pending(without.code)).deviceKey).toBeNull();
  });

  it("is refused when it is not 32 bytes of standard base64, and what was sent is not repeated", async () => {
    for (const [what, key] of [["31 bytes", b64(31)], ["33 bytes", b64(33)], ["not base64", "not base64 at all!!"], ["a number", 7]] as const) {
      const refused = await device().start("agents", "bad key", key as string);
      expectRefusal(refused, 400, what);
      expect(refused.text, what).not.toContain(String(key));
    }
  });
});

describe("the owner's device allows a sign-in with a sealed approval", () => {
  it("is handed to the new device in its first poll with the token, once, and then it is deleted", async () => {
    const sign = await started("collects it");
    const left = sealed();
    expect(bodyOf(await device(owner).approve(sign.code, left)).result).toBe("approved");
    expect(await approvalsStored(sign.code), "the server keeps the sealed approval for the device").toBe(1);
    expect((await device(owner).pending(sign.code)).text, "nobody is shown it before it is collected").not.toContain(left.approval);

    const polled = bodyOf(await device().poll(sign.secret));
    expect(polled).toMatchObject({ status: "approved", approval: left.approval, approverKey: left.approverKey });
    expect(polled.token).toMatch(/^nx_/);
    expect(await approvalsStored(sign.code), "gone the moment it is collected").toBe(0);

    const again = await device().poll(sign.secret);
    expectRefusal(again, 410, "a second poll");
    expect(again.text).not.toContain(left.approval);
  });

  it("is null for a sign-in the owner allowed with no approval, such as from the approval page", async () => {
    const sign = await started("allowed from the page");
    bodyOf(await device(owner).approve(sign.code));
    expect(bodyOf(await device().poll(sign.secret))).toMatchObject({ status: "approved", approval: null, approverKey: null });
  });

  it("gives each device the approval left for it and no other", async () => {
    const one = await started("first of two");
    const two = await started("second of two");
    const forOne = sealed();
    const forTwo = sealed();
    bodyOf(await device(owner).approve(two.code, forTwo));
    bodyOf(await device(owner).approve(one.code, forOne));
    expect(bodyOf(await device().poll(one.secret))).toMatchObject({ approval: forOne.approval, approverKey: forOne.approverKey });
    expect(bodyOf(await device().poll(two.secret))).toMatchObject({ approval: forTwo.approval, approverKey: forTwo.approverKey });
  });

  it("is turned away, with the sign-in still waiting, unless it is a whole approval for a device that sent a key", async () => {
    const sign = await started("turned away");
    const noKey = await started("sent no key", null);
    const turnedAway: Array<[string, string, Record<string, unknown>, number]> = [
      ["an approval with no approving key", sign.code, { approval: b64(100) }, 400],
      ["an approving key with no approval", sign.code, { approverKey: b64(32) }, 400],
      ["an approving key of 31 bytes", sign.code, { approval: b64(100), approverKey: b64(31) }, 400],
      ["an approval that is not base64", sign.code, { approval: "not base64!!", approverKey: b64(32) }, 400],
      ["an approval that is empty", sign.code, { approval: "", approverKey: b64(32) }, 400],
      [`an approval over ${MAX_APPROVAL_BYTES} bytes`, sign.code, { approval: b64(MAX_APPROVAL_BYTES + 1), approverKey: b64(32) }, 413],
      ["another field", sign.code, { ...sealed(), colour: "red" }, 400],
      ["an approval for a device that sent no key", noKey.code, sealed(), 400],
    ];
    for (const [what, code, extra, status] of turnedAway) {
      expectRefusal(await device(owner).approve(code, extra), status, what);
    }
    expect(await approvalsStored(sign.code), "nothing was kept").toBe(0);
    expect(await approvalsStored(noKey.code), "nothing was kept for the device with no key").toBe(0);
    expect(bodyOf(await device().poll(sign.secret)), "the sign-in is still waiting for an answer").toMatchObject({ status: "pending" });
    expect(bodyOf(await device().poll(noKey.secret))).toMatchObject({ status: "pending" });
  });

  it("is the owner's to leave: another identity's token is turned away and nothing is kept", async () => {
    const sign = await started("not by an agent");
    expectRefusal(await device(agents).approve(sign.code, sealed()), 403, "an agent leaving an approval");
    expectRefusal(await device(null).approve(sign.code, sealed()), 401, "nobody leaving an approval");
    expect(await approvalsStored(sign.code)).toBe(0);
  });

  it("can be left by the owner's own device with its token, and that device's writes are the device's", async () => {
    const phone = tokenFor(() => ownerCookie, "owner", "the owner's approving phone");
    const sign = await started("approved by a phone");
    expect(bodyOf(await device(phone).approve(sign.code, sealed())).result).toBe("approved");
    const polled = bodyOf(await device().poll(sign.secret));
    expect(bodyOf(await vaultAs({ bearer: polled.token }).save(GARDEN_V1, 0))).toMatchObject({ result: "saved" });
    expect(bodyOf(await vaultAs(owner).note(GARDEN_V1.id)).writer, "the new device is its own writer").toBe(await writerOf(ownerCookie, "approved by a phone"));
    const tokens = bodyOf(await manage(owner).tokens()).tokens;
    expect(JSON.stringify(tokens), "the list of tokens carries no approval").not.toContain(polled.approval);
  });
});

describe("an approval is deleted when its sign-in runs out", () => {
  it("is gone after ten minutes when the device never collected it: the poll is told so and the row is deleted", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sign = await started("never collects");
    const left = sealed();
    bodyOf(await device(owner).approve(sign.code, left));
    expect(await approvalsStored(sign.code)).toBe(1);

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    const polled = await device().poll(sign.secret);
    expectRefusal(polled, 410, "polling after it ran out");
    expect(polled.text).not.toContain(left.approval);
    expect(await approvalsStored(sign.code), "the approval was deleted by the poll").toBe(0);
  });

  it("is deleted by the next sign-in that starts, when nobody ever polled for it", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sign = await started("is forgotten");
    bodyOf(await device(owner).approve(sign.code, sealed()));

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    expect(await approvalsStored(sign.code), "nothing runs on its own when it runs out").toBe(1);
    await started("starts after");
    expect(await approvalsStored(sign.code), "the next start sweeps it").toBe(0);
  });

  it("is deleted by the next allow too, and cannot be collected in the meantime", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const forgotten = await started("is forgotten too");
    bodyOf(await device(owner).approve(forgotten.code, sealed()));

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    // Starting would sweep it already, so make the next sign-in first (at the earlier time is not possible): allow it, which sweeps too.
    const next = await started("allowed after");
    expect(await approvalsStored(forgotten.code), "starting a sign-in swept it").toBe(0);
    bodyOf(await device(owner).approve(next.code, sealed()));
    expect(await approvalsStored(next.code), "only the new one is kept").toBe(1);
    expectRefusal(await device().poll(forgotten.secret), 410, "collecting what ran out");
  });
});
