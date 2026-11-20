// The code the new device shows for its own key, and the approval page's use of it: GET /device/pending carries `deviceCode`, worked
// out by the server from the public key the device sent, so the page can show the owner the same code as the new device's screen
// (boards 1 and 14: one code, ten symbols). The server holds no encryption library, so the code is made from the host's SHA-256 and
// the one function the encryption package writes it with; this file holds that to the codes the real `deviceKeyCode` gave for real
// keys (__fixtures__/device-keys.ts says how they were made).
// Through the real Worker (see __fixtures__/identity-world.ts for the shape).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { device, type Who } from "./__fixtures__/identity-world";
import { DEVICE_KEYS, PINNED_KEY } from "./__fixtures__/device-keys";

let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
});

afterEach(() => {
  vi.useRealTimers();
});

async function startedAs(label: string, key?: string) {
  return bodyOf(await device().start("agents", label, key)) as { code: string };
}

describe("the code the page shows for a new device", () => {
  it("is the code the device shows for its own key: what a real device worked out from the public key it sent", async () => {
    for (const { key, code } of DEVICE_KEYS) {
      const sign = await startedAs("MacBook", key);
      const asked = bodyOf(await device(owner).pending(sign.code));
      expect(asked.label).toBe("MacBook");
      expect(asked.deviceCode, `the code of ${key}, written as the device writes it`).toBe(code);
      expect(asked.deviceCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(asked.deviceKey, "the key it was made from is still handed over").toBe(key);
    }
  });

  it("is the code the format document pins for the key it names, and another key has another code", async () => {
    const asked = bodyOf(await device(owner).pending((await startedAs("lab-pinned", PINNED_KEY.key)).code));
    expect(asked.deviceCode).toBe(PINNED_KEY.code);
    const other = bodyOf(await device(owner).pending((await startedAs("lab-pinned-other", DEVICE_KEYS[0]!.key)).code));
    expect(other.deviceCode).not.toBe(PINNED_KEY.code);
  });

  it("is null for a sign-in that sent no key, which has no such code", async () => {
    const asked = bodyOf(await device(owner).pending((await startedAs("lab-no-key")).code));
    expect(asked.deviceCode).toBeNull();
    expect(asked.deviceKey).toBeNull();
  });

  it("is not in the list of sign-ins waiting: that list is only the label and the sign-in's code", async () => {
    const sign = await startedAs("lab-list-no-key-code", PINNED_KEY.key);
    const answer = await device(owner).waiting();
    expect(answer.text, "no key code, no key").not.toContain(PINNED_KEY.code);
    expect(answer.text).not.toContain(PINNED_KEY.key);
    const mine = (bodyOf(answer).signins as Array<Record<string, unknown>>).find((entry) => entry.label === "lab-list-no-key-code");
    expect(mine).toEqual({ label: "lab-list-no-key-code", code: sign.code });
  });

  it("is given to the owner only, and a code that is finished is refused as it was", async () => {
    const sign = await startedAs("lab-owner-only", PINNED_KEY.key);
    const stranger = await device(null).pending(sign.code);
    expectRefusal(stranger, 401, "nobody");
    expect(stranger.text).not.toContain(PINNED_KEY.code);
    bodyOf(await device(owner).deny(sign.code));
    expectRefusal(await device(owner).pending(sign.code), 410, "an answered sign-in");
  });
});
