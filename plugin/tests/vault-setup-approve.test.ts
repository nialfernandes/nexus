// An unlocked device approves another: a new device (the key code typed here must be the key code of the key Nexus gave this device,
// and nothing that could carry the key is sent until it is), or an agent (its public key pasted; the approval is shown and saved by
// the person, and never sent through Nexus). The agent's approval is opened here by packages/agent itself, and so is the one the
// `nexus-agent approve-agent` command prints from the Recovery Key: either can be used. Against the real server (real-nexus.ts).

import { deviceKeyCode, generateDeviceKeyPair } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "../src/base64";
import { SETUP_WORDS } from "../src/vault-setup";
import { ENV, LABEL } from "../../packages/agent/src/cli/labels";
import { AgentVault } from "../../packages/agent/src/index";
import { ADDRESS, fetchOverNexus, run, valueOf } from "../../packages/agent/tests/world";
import { at, firstRun, setupDevice } from "./setup-world";
import { everythingStored, forbidFetch, hostileServer, openWorld, type World } from "./world";

let world: World;

beforeEach(async () => {
  world = await openWorld();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("this device approves another device", () => {
  it("refuses a key code that is not the key Nexus gave it, sending nothing, and approves when the right one is typed", async () => {
    const { device: a } = await firstRun(world, { files: { "Ideas/one.md": "first\n" } });
    await a.engine.sync();
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();

      await a.setup.approveDevice(waiting.code, "AAAAA-AAAAA");
      expect(a.setup.state, "refused with a reason, and still at the form").toEqual({
        step: "approve-device",
        message: expect.stringMatching(/does not match the key Nexus gave this device, so nothing was sent/),
      });
      await a.setup.approveDevice(waiting.code, "not a code at all");
      expect(a.setup.state.step).toBe("approve-device");
      expect(a.log.to("POST device/approve"), "nothing that could carry the key was sent").toEqual([]);
      expect(hostileServer().approvalsHeld(waiting.code)).toBe(0);

      await a.setup.approveDevice(`  ${waiting.code} `, waiting.keyCode.toLowerCase());
      matching = at(a, "device-approved").code;
    };
    await b.setup.askAnotherDevice();
    await b.setup.typeMatchingCode(matching);
    expect(b.setup.state).toEqual({ step: "unlocked" });
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
      // The person types the code B really shows. The key A was handed is the attacker's, so the codes differ.
      await a.setup.approveDevice(waiting.code, waiting.keyCode);
      expect(a.setup.state).toEqual({ step: "approve-device", message: expect.stringMatching(/does not match the key Nexus gave this device/) });
      // Even the attacker's own code, which the person cannot know, is the only one that would pass: they never see it.
      expect(await deviceKeyCode(attacker.publicKey)).not.toBe(waiting.keyCode);
      b.setup.cancel();
    };
    await b.setup.askAnotherDevice();
    expect(a.log.to("POST device/approve"), "no key was sealed to the attacker").toEqual([]);
    expect(a.holder.keys()).not.toBeNull();
  });

  it("says plainly when Nexus has no sign-in with that code, and is only for an unlocked device", async () => {
    const { device: a } = await firstRun(world);
    a.setup.startApprovingDevice();
    await a.setup.approveDevice("NOSUCHCODE", "AAAAA-AAAAA");
    expect(a.setup.state).toEqual({ step: "approve-device", message: "Nexus has no sign-in with that code." });
    a.setup.done();
    expect(a.setup.state).toEqual({ step: "unlocked" });

    const locked = await setupDevice(world);
    locked.setup.startApprovingDevice();
    expect(locked.setup.state, "a locked device has no key to give").toEqual({ step: "locked" });
    await locked.setup.approveDevice("CODE", "AAAAA-AAAAA");
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
    await first.setup.typeBack(shown.recoveryKey.split("-").at(-1)!);
    expect(first.log.to("POST wrap"), "the key that was shown is gone: nothing is sent").toEqual([]);

    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null });
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device");
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.code, waiting.keyCode);
    };
    await b.setup.askAnotherDevice();
    at(b, "type-matching-code");
    b.setup.lock();
    expect(b.setup.state).toEqual({ step: "locked" });
    expect(b.holder.keys()).toBeNull();
    expect(b.saved.some((d) => d.token !== null), "no token was kept").toBe(false);
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
