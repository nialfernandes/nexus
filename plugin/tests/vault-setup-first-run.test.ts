// First run: the server holds no vault. The setup controller makes the vault key, the vault id and the Recovery Key, shows the key, and
// asks for the last group of four characters back (three tries, exactly as `nexus-agent create-vault` does). Only when it is typed back
// does it send the Recovery wrap, with the vault id, and unlock. Against the real server (real-nexus.ts); the key steps are the shared
// ones (@nexus/agent/setup), so the wrap it sends is the one the command would send.

import { generateRecoveryKey, generateVaultKey, parseRecoveryKey, unwrapVaultKeyWithRecoveryKey, wrapVaultKeyWithRecoveryKey } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNREACHABLE } from "../src/approval";
import { encodeBase64 } from "../src/base64";
import { SETUP_WORDS } from "../src/vault-setup";
import { at, lastGroup, notTheLastGroup, setupDevice } from "./setup-world";
import { askNexus, bodyOf, everythingStored, forbidFetch, openWorld, type World } from "./world";

let world: World;

beforeEach(async () => {
  world = await openWorld();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const wrapsOnServer = async () => bodyOf(await askNexus("GET", "wraps", { cookie: world.ownerCookie }));

describe("first run, with no vault on the server", () => {
  it("asks what Nexus holds, shows the Recovery Key with nothing sent, and only after the check characters are typed back sends the wrap with the vault id and unlocks", async () => {
    const device = await setupDevice(world, { files: { "Ideas/one.md": "first\n" } });
    expect(device.setup.state, "starts locked").toEqual({ step: "locked" });

    await device.setup.begin();
    expect(device.setup.state).toEqual({ step: "no-vault" });
    expect(device.log.requests().map((r) => `${r.method} ${r.route}`), "begin only asks what Nexus holds").toEqual(["GET wraps"]);

    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    expect(shown.recoveryKey, "14 groups of 4").toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){13}$/);
    expect(shown.triesLeft).toBe(3);
    expect(device.holder.keys(), "still locked").toBeNull();
    expect(device.log.to("POST wrap"), "nothing sent yet").toEqual([]);
    expect(await wrapsOnServer(), "and the server holds no vault").toMatchObject({ vaultId: null, wraps: [] });

    // The first try is wrong, the second is right (small letters and a space do not matter).
    await device.setup.typeBack(notTheLastGroup(shown.recoveryKey));
    const second = at(device, "show-key");
    expect(second.triesLeft).toBe(2);
    expect(second.message, "told in plain words").toMatch(/not the last four characters/i);
    expect(second.recoveryKey, "the same key is still shown").toBe(shown.recoveryKey);
    expect(device.log.to("POST wrap"), "a wrong try sends nothing").toEqual([]);
    expect(device.holder.keys()).toBeNull();

    await device.setup.typeBack(` ${lastGroup(shown.recoveryKey).toLowerCase()} `);
    expect(device.setup.state).toEqual({ step: "unlocked" });

    // The wrap went with the vault id, and is the one the Recovery Key opens.
    const posted = device.log.to("POST wrap");
    expect(posted).toHaveLength(1);
    expect(Object.keys(posted[0]!.body).sort()).toEqual(["kid", "kind", "vaultId", "wrap"]);
    expect(posted[0]!.body).toMatchObject({ kid: 1, kind: "recovery" });
    const keys = device.holder.keys()!;
    expect(keys).toMatchObject({ vaultId: posted[0]!.body.vaultId, kid: 1 });
    expect(keys.vaultKey).toHaveLength(32);
    const held = await wrapsOnServer();
    expect(held.vaultId, "Nexus keeps the vault id beside the wraps").toBe(keys.vaultId);
    expect(held.wraps).toHaveLength(1);
    const opened = await unwrapVaultKeyWithRecoveryKey(await parseRecoveryKey(shown.recoveryKey), new Uint8Array(Buffer.from(held.wraps[0].wrap, "base64")), { vaultId: held.vaultId, kid: 1 });
    expect(Array.from(opened), "the Recovery Key opens the wrap to the vault key the device holds").toEqual(Array.from(keys.vaultKey));

    // The vault is unlocked: the engine syncs with it, and the key is nowhere Nexus or the device's data can see.
    await device.engine.sync();
    expect(device.engine.status()).not.toMatch(/locked/i);
    expect(device.log.to("POST save"), "the note went up").toHaveLength(1);
    const stored = everythingStored();
    const written = JSON.stringify([device.saved, device.deps.data]);
    for (const secret of [encodeBase64(keys.vaultKey), Buffer.from(keys.vaultKey).toString("hex"), shown.recoveryKey, shown.recoveryKey.replace(/-/g, "")]) {
      expect(stored, "not in what Nexus holds").not.toContain(secret);
      expect(written, "not in what the device keeps").not.toContain(secret);
    }
  });

  it("gives up after three wrong tries: nothing is sent, nothing is unlocked, the server holds no vault, and a new start makes a new key", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const first = at(device, "show-key");

    await device.setup.typeBack(notTheLastGroup(first.recoveryKey));
    expect(at(device, "show-key").triesLeft).toBe(2);
    await device.setup.typeBack("");
    expect(at(device, "show-key").triesLeft).toBe(1);
    await device.setup.typeBack(first.recoveryKey.slice(0, 4));
    expect(device.setup.state).toMatchObject({ step: "stopped", reason: "type-back-failed" });
    expect((device.setup.state as { message: string }).message).toBe(SETUP_WORDS.typeBackFailed);

    // The right characters now are too late: that key was thrown away.
    await device.setup.typeBack(lastGroup(first.recoveryKey));
    expect(device.setup.state.step).toBe("stopped");
    expect(device.log.to("POST wrap"), "nothing was posted").toEqual([]);
    expect(device.holder.keys(), "nothing was unlocked").toBeNull();
    expect(await wrapsOnServer()).toMatchObject({ vaultId: null, wraps: [] });
    expect(JSON.stringify(device.states), "the key is shown in no state but show-key").not.toContain(first.recoveryKey.replace(/-/g, "").slice(0, 20));
    expect(device.states.filter((s) => s.step === "show-key").length).toBe(3);

    await device.setup.begin();
    await device.setup.startFirstRun();
    expect(at(device, "show-key").recoveryKey, "a new key").not.toBe(first.recoveryKey);
  });

  it("keeps the same wrap for another try when Nexus cannot be reached after the check characters were right", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");

    device.network.online = false;
    await device.setup.typeBack(lastGroup(shown.recoveryKey));
    expect(device.setup.state).toEqual({ step: "save-failed", message: UNREACHABLE });
    expect(device.holder.keys(), "nothing is unlocked without the wrap kept").toBeNull();
    await device.setup.typeBack(lastGroup(shown.recoveryKey));
    expect(device.setup.state.step, "typing back again is not what the step takes").toBe("save-failed");

    device.network.online = true;
    await device.setup.tryAgain();
    expect(device.setup.state).toEqual({ step: "unlocked" });
    const held = await wrapsOnServer();
    const opened = await unwrapVaultKeyWithRecoveryKey(await parseRecoveryKey(shown.recoveryKey), new Uint8Array(Buffer.from(held.wraps[0].wrap, "base64")), { vaultId: held.vaultId, kid: 1 });
    expect(Array.from(opened), "the key that was shown is the key that was kept").toEqual(Array.from(device.holder.keys()!.vaultKey));
  });

  it("refuses a token that is not the owner's before any key is made, so nothing is written down for nothing", async () => {
    const agentsToken = await world.tokenFor("agents", "not the owner");
    const device = await setupDevice(world, { token: agentsToken, user: "agents" });
    await device.setup.begin();
    expect(device.setup.state).toEqual({ step: "no-vault" });
    await device.setup.startFirstRun();
    expect(device.setup.state).toMatchObject({ step: "stopped", reason: "not-owner", message: SETUP_WORDS.notOwner });
    expect(device.states.some((s) => s.step === "show-key"), "no key was ever shown").toBe(false);
    expect(device.log.to("POST wrap")).toEqual([]);
  });

  it("goes to has-vault, and shows no key, when another device made the vault between asking and starting", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    expect(device.setup.state.step).toBe("no-vault");
    await sealedVaultOnServer("a-vault-made-elsewhere");

    await device.setup.startFirstRun();
    expect(device.setup.state).toEqual({ step: "has-vault", message: SETUP_WORDS.holdsOne });
    expect(device.states.some((s) => s.step === "show-key")).toBe(false);
    expect(device.log.to("POST wrap")).toEqual([]);
  });

  it("refuses with a plain message and keeps nothing when the server turns out to hold a vault with another vault id", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    await sealedVaultOnServer("a-vault-made-meanwhile");

    await device.setup.typeBack(lastGroup(shown.recoveryKey));
    expect(device.setup.state).toEqual({ step: "stopped", reason: "other-vault", message: SETUP_WORDS.otherVault });
    expect(device.holder.keys(), "nothing was unlocked").toBeNull();
    expect((await wrapsOnServer()).vaultId, "and the other vault is as it was").toBe("a-vault-made-meanwhile");
  });

  it("does nothing for a step's event that arrives at another step", async () => {
    const device = await setupDevice(world);
    await device.setup.typeBack("ABCD");
    await device.setup.tryAgain();
    await device.setup.typeRecoveryKey("anything");
    await device.setup.startFirstRun();
    await device.setup.typeMatchingCode("12345-12345");
    device.setup.refuseCode();
    device.setup.startApprovingAgent();
    await device.setup.approveAgent("anything");
    device.setup.done();
    expect(device.setup.state).toEqual({ step: "locked" });
    expect(device.log.requests(), "and sent nothing").toEqual([]);
  });
});

/** The server comes to hold a vault with this vault id: what another device's first run does. */
async function sealedVaultOnServer(vaultId: string): Promise<void> {
  const wrap = await wrapVaultKeyWithRecoveryKey(await generateRecoveryKey(), await generateVaultKey(), { vaultId, kid: 1 });
  bodyOf(await askNexus("POST", "wrap", { cookie: world.ownerCookie }, { kid: 1, kind: "recovery", wrap: encodeBase64(wrap), vaultId }));
}
