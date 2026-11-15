// A vault exists, and this device unlocks it: with the Recovery Key (the wrap and the vault id come from Nexus), or by asking another
// device that is unlocked to approve it (the two-code exchange the engine has, approval.ts, driven here as states). A wrong Recovery Key,
// a wrong matching code and a refused sign-in each end with nothing unlocked and nothing kept. Against the real server (real-nexus.ts).

import { formatRecoveryKey, generateRecoveryKey } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNREACHABLE } from "../src/approval";
import { SETUP_WORDS } from "../src/vault-setup";
import { run, valueOf } from "../../packages/agent/tests/world";
import { ENV, LABEL } from "../../packages/agent/src/cli/labels";
import { at, firstRun, setupDevice } from "./setup-world";
import { deviceRoutes, forbidFetch, openWorld, type World } from "./world";

let world: World;

beforeEach(async () => {
  world = await openWorld();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a vault exists and this device has the Recovery Key", () => {
  it("reads the vault id and the Recovery wrap from Nexus and unlocks with the key typed (small letters, no hyphens), and the engine then syncs the first device's notes", async () => {
    const { device: first, recoveryKey } = await firstRun(world, { files: { "Ideas/one.md": "first\n", "Ideas/two.md": "second\n" } });
    await first.engine.sync();

    const second = await setupDevice(world);
    await second.setup.begin();
    expect(second.setup.state).toEqual({ step: "has-vault", message: null });
    await second.setup.typeRecoveryKey(recoveryKey.replace(/-/g, "").toLowerCase());
    expect(second.setup.state).toEqual({ step: "unlocked" });
    expect(second.holder.keys()).toMatchObject({ vaultId: first.holder.keys()!.vaultId, kid: 1 });
    expect(Array.from(second.holder.keys()!.vaultKey)).toEqual(Array.from(first.holder.keys()!.vaultKey));
    expect(second.log.to("POST wrap"), "it only read").toEqual([]);

    await second.engine.sync();
    expect(second.vault.texts()).toEqual({ "Ideas/one.md": "first\n", "Ideas/two.md": "second\n" });
  });

  it("unlocks a vault the nexus-agent command made, with the Recovery Key the command showed: one wrap, two makers", async () => {
    const owner = await world.tokenFor(world.user, "the owner's terminal");
    const { fetchOverNexus, ADDRESS } = await import("../../packages/agent/tests/world");
    const fetched = fetchOverNexus();
    let answered = 0;
    const ran = await run(["create-vault"], {
      env: { [ENV.address]: ADDRESS, [ENV.token]: owner }, screen: true, fetch: fetched.fetch,
      reply: (printed) => {
        const asked = (printed.stderr.match(/\(the last group\): /g) ?? []).length;
        if (printed.stderr.endsWith("(the last group): ") && answered < asked) {
          answered++;
          return `${valueOf(printed.stdout, LABEL.recoveryKey)!.split("-").at(-1)}\n`;
        }
        return undefined;
      },
    });
    expect(ran.code).toBe(0);
    const recoveryKey = valueOf(ran.stdout, LABEL.recoveryKey)!;
    const vaultId = valueOf(ran.stdout, LABEL.vaultId)!;

    const device = await setupDevice(world);
    await device.setup.begin();
    expect(device.setup.state.step).toBe("has-vault");
    await device.setup.typeRecoveryKey(recoveryKey);
    expect(device.setup.state).toEqual({ step: "unlocked" });
    expect(device.holder.keys()?.vaultId).toBe(vaultId);
  });

  it("refuses a wrong Recovery Key, one that is not whole and none at all, each with a plain message, nothing kept and nothing unlocked; the right one then opens", async () => {
    const { recoveryKey } = await firstRun(world);
    const device = await setupDevice(world);
    await device.setup.begin();
    const before = device.saved.length;

    const another = await formatRecoveryKey(await generateRecoveryKey());
    await device.setup.typeRecoveryKey(another);
    expect(device.setup.state).toEqual({ step: "has-vault", message: SETUP_WORDS.wrongRecoveryKey });
    expect(device.holder.keys()).toBeNull();

    await device.setup.typeRecoveryKey(recoveryKey.slice(0, -1));
    expect(device.setup.state).toEqual({ step: "has-vault", message: SETUP_WORDS.incompleteRecoveryKey });
    await device.setup.typeRecoveryKey(`${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("0") ? "1" : "0"}`);
    expect(device.setup.state, "a mistyped character is caught by the key's own check").toEqual({ step: "has-vault", message: SETUP_WORDS.incompleteRecoveryKey });
    await device.setup.typeRecoveryKey("   ");
    expect(device.setup.state).toEqual({ step: "has-vault", message: SETUP_WORDS.noRecoveryKey });

    expect(device.holder.keys(), "still locked").toBeNull();
    expect(device.saved.length, "nothing was kept").toBe(before);
    expect(device.log.to("POST wrap"), "nothing was sent").toEqual([]);
    expect(device.engine.status()).toMatch(/locked/i);

    await device.setup.typeRecoveryKey(recoveryKey);
    expect(device.setup.state).toEqual({ step: "unlocked" });
  });

  it("says so, and keeps the person at the same step, when Nexus cannot be reached while the key is checked", async () => {
    const { recoveryKey } = await firstRun(world);
    const device = await setupDevice(world);
    await device.setup.begin();
    device.network.online = false;
    await device.setup.typeRecoveryKey(recoveryKey);
    expect(device.setup.state).toEqual({ step: "has-vault", message: UNREACHABLE });
    expect(device.holder.keys()).toBeNull();
    device.network.online = true;
    await device.setup.typeRecoveryKey(recoveryKey);
    expect(device.setup.state.step).toBe("unlocked");
  });

  it("does not start while the plugin is not set up, and sends nothing; a device with no token is offered another device's approval", async () => {
    const notSetUp = await setupDevice(world, { address: "", user: "" });
    await notSetUp.setup.begin();
    expect(notSetUp.setup.state).toMatchObject({ step: "stopped", reason: "not-set-up" });
    expect(notSetUp.log.requests()).toEqual([]);

    const signedOut = await setupDevice(world, { token: null });
    await signedOut.setup.begin();
    expect(signedOut.setup.state).toEqual({ step: "signed-out" });
    await signedOut.setup.typeRecoveryKey("anything");
    expect(signedOut.setup.state, "a Recovery Key is not what a signed-out device is asked for").toEqual({ step: "signed-out" });
    expect(signedOut.log.requests()).toEqual([]);
  });

  it("forgets a token Nexus no longer knows, as the engine does, and says the device is signed out", async () => {
    const device = await setupDevice(world, { token: "nx_not_a_token_nexus_knows" });
    await device.setup.begin();
    expect(device.setup.state).toEqual({ step: "signed-out" });
    expect(device.deps.data.token).toBeNull();
    expect(device.data().token, "and it was saved that way").toBeNull();
  });
});

describe("a new device approved from another", () => {
  it("waits, shows the link, the sign-in code and the key code, and is unlocked once the matching code the approving device shows is typed", async () => {
    const { device: a } = await firstRun(world, { files: { "Ideas/one.md": "first\n", "Ideas/two.md": "second\n" }, name: "Device A" });
    await a.engine.sync();

    const b = await setupDevice(world, { token: null, name: "New phone" });
    await b.setup.begin();
    expect(b.setup.state).toEqual({ step: "signed-out" });

    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      expect(waiting.link).toContain("/");
      expect(b.opened, "the link was opened in a browser").toEqual([waiting.link]);
      expect(waiting.keyCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      a.setup.startApprovingDevice();
      expect(a.setup.state).toEqual({ step: "approve-device", message: null });
      await a.setup.approveDevice(waiting.code, waiting.keyCode);
      const approved = at(a, "device-approved");
      expect(approved.label).toBe("New phone");
      matching = approved.code;
    };
    await b.setup.askAnotherDevice();
    const asked = at(b, "type-matching-code");
    expect(asked.triesLeft).toBe(3);
    expect(b.holder.keys(), "locked until the person has typed the code").toBeNull();
    expect(b.deps.data.token, "and no token kept").toBeNull();
    expect(b.saved.some((d) => d.token !== null)).toBe(false);

    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "unlocked" });
    expect(b.deps.data.token).toMatch(/^nx_/);
    expect(Array.from(b.holder.keys()!.vaultKey)).toEqual(Array.from(a.holder.keys()!.vaultKey));
    a.setup.done();
    expect(a.setup.state).toEqual({ step: "unlocked" });

    await b.engine.sync();
    expect(b.vault.texts()).toEqual({ "Ideas/one.md": "first\n", "Ideas/two.md": "second\n" });
  });

  /** B asks, A approves, and B is left at "type-matching-code" with the code A showed. */
  async function asked() {
    const { device: a } = await firstRun(world, { files: { "Ideas/one.md": "first\n" }, name: "Device A" });
    await a.engine.sync();
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.code, waiting.keyCode);
      matching = at(a, "device-approved").code;
    };
    await b.setup.askAnotherDevice();
    at(b, "type-matching-code");
    return { a, b, matching };
  }

  it("refuses a wrong matching code three times: the approval is thrown away, nothing is unlocked, no token is kept, and the right code is then too late", async () => {
    const { b, matching } = await asked();
    const wrong = matching.startsWith("A") ? "BBBBB-BBBBB" : "AAAAA-AAAAA";

    await b.setup.typeMatchingCode(wrong);
    expect(b.setup.state).toEqual({ step: "type-matching-code", triesLeft: 2, message: SETUP_WORDS.wrongMatchingCode });
    await b.setup.typeMatchingCode("nonsense");
    expect(at(b, "type-matching-code").triesLeft).toBe(1);
    expect(b.holder.keys(), "still locked").toBeNull();
    await b.setup.typeMatchingCode(wrong);
    expect(b.setup.state).toEqual({ step: "stopped", reason: "codes-differ", message: SETUP_WORDS.codesDiffer });

    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state.step, "the approval is gone").toBe("stopped");
    expect(b.holder.keys()).toBeNull();
    expect(b.deps.data.token).toBeNull();
    expect(b.saved.some((d) => d.token !== null), "no token was ever kept").toBe(false);
    expect(b.engine.status()).toMatch(/signed out|locked/i);
  });

  it("allows a typing mistake: two wrong codes and then the right one unlocks", async () => {
    const { b, matching } = await asked();
    await b.setup.typeMatchingCode("AAAAA-AAAAA".replace(/A/g, matching.startsWith("A") ? "B" : "A"));
    await b.setup.typeMatchingCode("");
    expect(at(b, "type-matching-code").triesLeft).toBe(1);
    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "unlocked" });
  });

  it("throws the approval away when the person says the codes do not match: nothing unlocked, no token kept", async () => {
    const { b, matching } = await asked();
    b.setup.refuseCode();
    expect(b.setup.state).toEqual({ step: "stopped", reason: "codes-differ", message: SETUP_WORDS.refusedByPerson });
    await b.setup.typeMatchingCode(matching);
    expect(b.holder.keys()).toBeNull();
    expect(b.saved.some((d) => d.token !== null)).toBe(false);
  });

  it("stops polling when the person cancels, and is locked", async () => {
    const b = await setupDevice(world, { token: null });
    let pauses = 0;
    b.whenWaiting = async () => {
      pauses++;
      b.setup.cancel();
    };
    await b.setup.askAnotherDevice();
    expect(pauses, "one pause, and no more").toBe(1);
    expect(b.setup.state).toEqual({ step: "locked" });
    expect(b.log.to("POST device/poll"), "it never asked Nexus whether it was answered").toEqual([]);
  });

  it("says plainly when the owner denies the sign-in, and nothing is kept", async () => {
    const b = await setupDevice(world, { token: null });
    b.whenWaiting = async () => {
      const waiting = at(b, "waiting-for-device");
      await deviceRoutes({ cookie: world.ownerCookie }).deny(waiting.code);
    };
    await b.setup.askAnotherDevice();
    expect(b.setup.state).toEqual({ step: "stopped", reason: "denied", message: SETUP_WORDS.denied });
    expect(b.deps.data.token).toBeNull();
    expect(b.holder.keys()).toBeNull();
  });

  it("is signed in but still locked when the owner allows it from the approval page with no key; the Recovery Key is then the way in", async () => {
    const { recoveryKey } = await firstRun(world);
    const b = await setupDevice(world, { token: null });
    b.whenWaiting = async () => {
      const waiting = at(b, "waiting-for-device");
      await deviceRoutes({ cookie: world.ownerCookie }).approve(waiting.code);
    };
    await b.setup.askAnotherDevice();
    expect(b.setup.state, "signed in, and it looked at what Nexus holds").toEqual({ step: "has-vault", message: null });
    expect(b.deps.data.token).toMatch(/^nx_/);
    expect(b.holder.keys()).toBeNull();
    await b.setup.typeRecoveryKey(recoveryKey);
    expect(b.setup.state.step).toBe("unlocked");
  });
});
