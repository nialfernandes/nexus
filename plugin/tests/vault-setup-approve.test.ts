// An unlocked device approves another: a new device (the one device code typed here must be the code of the key of a device that waits,
// worked out here from the key Nexus gave this device, and nothing that could carry the key is sent until it is), or an agent (its public key pasted; the approval is shown and saved by
// the person, and never sent through Nexus). The agent's approval is opened here by packages/agent itself, and so is the one the
// `nexus-agent approve-agent` command prints from the Recovery Key: either can be used. Against the real server (real-nexus.ts).

import { deviceKeyCode, generateDeviceKeyPair } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "../src/base64";
import { SETUP_WORDS } from "../src/vault-setup";
import { ENV, LABEL } from "../../packages/agent/src/cli/labels";
import { AgentVault } from "../../packages/agent/src/index";
import { ADDRESS, fetchOverNexus, run, valueOf } from "../../packages/agent/tests/world";
import { at, firstRun, groupsAsked, setupDevice } from "./setup-world";
import { bodyOf, deviceRoutes, everythingStored, forbidFetch, hostileServer, openWorld, type World } from "./world";

let world: World;

beforeEach(async () => {
  world = await openWorld();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("this device approves another device", () => {
  it("is typed the device code and nothing else: it refuses a code no waiting device has, sending nothing, and approves when the right one is typed", async () => {
    const { device: a } = await firstRun(world, { files: { "Ideas/one.md": "first\n" } });
    await a.engine.sync();
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();

      await a.setup.approveDevice("AAAAA-AAAAA");
      expect(a.setup.state, "refused with a reason, and still at the form").toEqual({
        step: "approve-device",
        message: expect.stringMatching(/No device that is waiting has that code, so nothing was sent/),
        problem: "wrong-key-code",
      });
      await a.setup.approveDevice("not a code at all");
      expect(a.setup.state.step).toBe("approve-device");
      expect(a.log.to("POST device/approve"), "nothing that could carry the key was sent").toEqual([]);
      expect(hostileServer().approvalsHeld(waiting.code)).toBe(0);

      // The sign-in code is not what is typed: it is not a device code, so it finds nothing.
      await a.setup.approveDevice(waiting.code);
      expect(a.setup.state).toMatchObject({ step: "approve-device", problem: "wrong-key-code" });
      expect(a.log.to("POST device/approve")).toEqual([]);

      await a.setup.approveDevice(`  ${waiting.keyCode.toLowerCase()} `);
      matching = at(a, "device-approved").code;
    };
    await b.setup.askAnotherDevice();
    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "device-unlocked" });
    expect(a.log.to("POST device/approve")).toHaveLength(1);
  });

  it("refuses, sending nothing, when a hostile server gave it a public key of its own in place of the new device's", async () => {
    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null });
    const attacker = await generateDeviceKeyPair();
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      hostileServer().swapDeviceKey(waiting.code, encodeBase64(attacker.publicKey));
      a.setup.startApprovingDevice();
      // The person types the code B really shows. The key A was handed is the attacker's, so its code is another and no device has this one.
      await a.setup.approveDevice(waiting.keyCode);
      expect(a.setup.state).toEqual({ step: "approve-device", message: expect.stringMatching(/No device that is waiting has that code/), problem: "wrong-key-code" });
      // Even the attacker's own code, which the person cannot know, is the only one that would pass: they never see it.
      expect(await deviceKeyCode(attacker.publicKey)).not.toBe(waiting.keyCode);
      b.setup.cancel();
    };
    await b.setup.askAnotherDevice();
    expect(a.log.to("POST device/approve"), "no key was sealed to the attacker").toEqual([]);
    expect(a.holder.keys()).not.toBeNull();
  });

  it("finds the new device from its device code however it was typed, and hands back the name it sent for the screen to show as text", async () => {
    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null, name: "<img src=x onerror=alert(1)> phone" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(` ${waiting.keyCode.replace("-", "").toLowerCase()} `); // as ten boxes give it: no hyphen, small letters
      expect(a.setup.state, "Nexus says which device it was: its label, as the device sent it").toEqual({
        step: "device-approved", code: expect.stringMatching(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/), label: "<img src=x onerror=alert(1)> phone",
      });
      matching = at(a, "device-approved").code;
    };
    await b.setup.askAnotherDevice();
    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "device-unlocked" });
  });

  it("picks the right device when others are waiting too, and the others stay waiting", async () => {
    const { device: a } = await firstRun(world);
    // Two other sign-ins wait, each with a key of its own, one asked for before the new device and one after.
    const earlier = bodyOf(await deviceRoutes().start(world.user, "Earlier phone", encodeBase64((await generateDeviceKeyPair()).publicKey)));
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      const later = bodyOf(await deviceRoutes().start(world.user, "Later phone", encodeBase64((await generateDeviceKeyPair()).publicKey)));
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.keyCode);
      expect(at(a, "device-approved").label).toBe("New phone");
      matching = at(a, "device-approved").code;
      for (const other of [earlier, later]) {
        expect(bodyOf(await deviceRoutes().poll(other.secret)), "the others are still waiting").toEqual({ status: "pending" });
      }
    };
    await b.setup.askAnotherDevice();
    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "device-unlocked" });
    expect(a.log.to("POST device/approve")).toHaveLength(1);
  });

  it("says plainly when no device is waiting at all, with its reason, and sends nothing", async () => {
    const { device: a } = await firstRun(world);
    a.setup.startApprovingDevice();
    await a.setup.approveDevice("4TQ8M-W2K0B");
    expect(a.setup.state).toEqual({ step: "approve-device", message: expect.stringMatching(/No device that is waiting has that code/), problem: "wrong-key-code" });
    expect(a.log.to("POST device/approve")).toEqual([]);
  });

  it("is told by Nexus that its account may not approve, and says so with the reason not-allowed and sends nothing to the new device", async () => {
    const { device: a } = await firstRun(world);
    a.deps.data.token = await world.tokenFor("agents", "not the owner");
    a.setup.startApprovingDevice();
    await a.setup.approveDevice("AAAAA-AAAAA");
    expect(a.setup.state).toMatchObject({ step: "approve-device", problem: "not-allowed" });
    expect(a.log.to("POST device/approve")).toEqual([]);
    a.setup.done();
    expect(a.setup.state).toEqual({ step: "unlocked" });
  });

  it("is only for an unlocked device", async () => {
    const locked = await setupDevice(world);
    locked.setup.startApprovingDevice();
    expect(locked.setup.state, "a locked device has no key to give").toEqual({ step: "locked" });
    await locked.setup.approveDevice("AAAAA-AAAAA");
    expect(locked.log.requests()).toEqual([]);
  });
});

describe("this device approves an agent", () => {
  /** The agent's own key pair, a token for it, and what it opens its vault with. */
  async function agentWith(approval: string, privateKey: Uint8Array) {
    const fetched = fetchOverNexus();
    return AgentVault.open({
      address: ADDRESS, token: await world.tokenFor("agents", "the agent under test"), privateKey: encodeBase64(privateKey), approval, fetch: fetched.fetch,
    });
  }

  it("seals the vault key to the pasted public key and shows the approval: opened by packages/agent, which reads the first device's notes, and the same as the command's", async () => {
    const { device: a, recoveryKey } = await firstRun(world, { files: { "Ideas/one.md": "first\n", "Ideas/two.md": "second\n" } });
    await a.engine.sync();
    const pair = await generateDeviceKeyPair();
    const requestsBefore = a.log.requests().length;

    a.setup.startApprovingAgent();
    expect(a.setup.state).toEqual({ step: "approve-agent", message: null });
    await a.setup.approveAgent(`  ${encodeBase64(pair.publicKey)}\n`);
    const shown = at(a, "agent-approved");
    expect(shown.publicKeyCode, "the code of the key it was given, to read against `nexus-agent keygen`").toBe(await deviceKeyCode(pair.publicKey));
    expect(a.log.requests().length, "the approval never went through Nexus").toBe(requestsBefore);
    expect(everythingStored(), "and Nexus does not hold it").not.toContain(shown.approval);

    const agent = await agentWith(shown.approval, pair.privateKey);
    expect(agent.vaultId).toBe(a.holder.keys()!.vaultId);
    expect(await agent.list()).toEqual(["Ideas/one.md", "Ideas/two.md"]);
    expect(await agent.read("Ideas/one.md")).toBe("first\n");
    agent.close();

    // The command, given the same public key and the Recovery Key, prints an approval of the same kind that opens the same way.
    const owner = await world.tokenFor(world.user, "the owner's terminal");
    const command = await run(["approve-agent"], {
      env: { [ENV.address]: ADDRESS, [ENV.token]: owner }, stdin: `${encodeBase64(pair.publicKey)}\n${recoveryKey}\n`, fetch: fetchOverNexus().fetch,
    });
    expect(command.code).toBe(0);
    const printed = valueOf(command.stdout, LABEL.approval)!;
    expect(Buffer.from(printed, "base64").length, "the same shape: the same number of bytes").toBe(Buffer.from(shown.approval, "base64").length);
    expect(printed, "a fresh seal each time").not.toBe(shown.approval);
    const byCommand = await agentWith(printed, pair.privateKey);
    expect(await byCommand.read("Ideas/two.md")).toBe("second\n");
    byCommand.close();

    a.setup.done();
    expect(a.setup.state).toEqual({ step: "unlocked" });
  });

  it("refuses what is not an agent's public key, with a plain message, and seals nothing", async () => {
    const { device: a } = await firstRun(world);
    a.setup.startApprovingAgent();
    const before = a.log.requests().length;
    for (const typed of ["", "not base64 at all!", encodeBase64(new Uint8Array(31)), encodeBase64(new Uint8Array(33)), encodeBase64(new Uint8Array(64))]) {
      await a.setup.approveAgent(typed);
      expect(a.setup.state, `"${typed}" is refused`).toEqual({ step: "approve-agent", message: SETUP_WORDS.notAPublicKey });
    }
    expect(a.log.requests().length).toBe(before);
    a.setup.cancel();
    expect(a.setup.state).toEqual({ step: "unlocked" });
  });

  it("is for an unlocked device only", async () => {
    const locked = await setupDevice(world);
    locked.setup.startApprovingAgent();
    await locked.setup.approveAgent(encodeBase64((await generateDeviceKeyPair()).publicKey));
    expect(locked.setup.state).toEqual({ step: "locked" });
  });
});

describe("locking", () => {
  it("drops the key on lock: it is overwritten with zeros, the engine says the vault is locked and sends nothing, and the setup is locked", async () => {
    const { device } = await firstRun(world, { files: { "Ideas/one.md": "first\n" } });
    await device.engine.sync();
    const held = device.holder.keys()!.vaultKey;
    expect(held.some((byte) => byte !== 0)).toBe(true);
    const seen = device.log.requests().length;

    device.setup.lock();
    expect(device.setup.state).toEqual({ step: "locked" });
    expect(device.holder.keys()).toBeNull();
    expect(held.every((byte) => byte === 0), "overwritten, not only forgotten").toBe(true);
    expect(device.engine.status()).toMatch(/locked/i);

    device.vault.type("Ideas/one.md", "edited while locked\n");
    await device.engine.push("Ideas/one.md");
    await device.engine.sync();
    expect(device.log.requests().length, "nothing was sent or read").toBe(seen);
  });

  it("drops what was going on: a first run's key, and a new device's approval", async () => {
    const first = await setupDevice(world);
    await first.setup.begin();
    await first.setup.startFirstRun();
    const shown = at(first, "show-key");
    first.setup.lock();
    expect(first.setup.state).toEqual({ step: "locked" });
    first.setup.typeBack(groupsAsked(shown));
    await first.setup.finishSetup(null);
    expect(first.setup.state, "a locked setup takes no more of the first run").toEqual({ step: "locked" });
    expect(first.log.to("POST wrap"), "the key that was shown is gone: nothing is sent").toEqual([]);

    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null });
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.keyCode);
    };
    await b.setup.askAnotherDevice();
    at(b, "type-matching-code");
    b.setup.lock();
    expect(b.setup.state).toEqual({ step: "locked" });
    expect(b.holder.keys()).toBeNull();
    expect(b.saved.some((d) => d.token !== null), "no token was kept").toBe(false);
  });

  it("stops a sign-in that is waiting for another device: it asks Nexus nothing more, and nothing is kept", async () => {
    const b = await setupDevice(world, { token: null });
    let pauses = 0;
    b.whenWaiting = async () => {
      pauses++;
      at(b, "waiting-for-device");
      b.setup.lock();
    };
    await b.setup.askAnotherDevice();
    expect(pauses, "it paused once, was locked, and did not go on").toBe(1);
    expect(b.setup.state).toEqual({ step: "locked" });
    expect(b.log.to("POST device/poll"), "it never asked whether the sign-in was answered").toEqual([]);
    expect(b.deps.data.token).toBeNull();
  });

  it("is cancelled by unload, which also stops telling anyone what changed", async () => {
    const { device } = await firstRun(world);
    const told = vi.fn();
    device.setup.onChange(told);
    const held = device.holder.keys()!.vaultKey;
    device.setup.unload();
    expect(device.holder.keys()).toBeNull();
    expect(held.every((byte) => byte === 0)).toBe(true);
    expect(told).not.toHaveBeenCalled();
  });
});
