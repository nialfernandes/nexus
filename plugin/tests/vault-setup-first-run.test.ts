// First run: the server holds no vault. The setup controller makes the vault key, the vault id and the Recovery Key, shows the key, and
// asks for three of its groups back (as many tries as the person needs). Only when they are typed back and the password step is finished
// does it send the Recovery wrap, with the vault id (and the password wrap after it, when a password was asked for), and unlock. Against
// the real server (real-nexus.ts); the key steps are the shared ones (@nexus/agent/setup), so the wrap it sends is the one the command would send.

import { generateRecoveryKey, generateVaultKey, parseRecoveryKey, unwrapVaultKeyWithRecoveryKey, wrapVaultKeyWithRecoveryKey } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNREACHABLE } from "../src/approval";
import { encodeBase64 } from "../src/base64";
import { SETUP_WORDS } from "../src/vault-setup";
import { at, groupsAsked, groupsAskedWithASlip, setupDevice } from "./setup-world";
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
  it("asks what Nexus holds, shows the Recovery Key with nothing sent, and only after the groups are typed back and the password step is finished sends the wrap with the vault id and unlocks", async () => {
    const device = await setupDevice(world, { files: { "Ideas/one.md": "first\n" } });
    expect(device.setup.state, "starts locked").toEqual({ step: "locked" });

    await device.setup.begin();
    expect(device.setup.state).toEqual({ step: "no-vault" });
    expect(device.log.requests().map((r) => `${r.method} ${r.route}`), "begin only asks what Nexus holds").toEqual(["GET wraps"]);

    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    expect(shown.recoveryKey, "14 groups of 4").toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){13}$/);
    expect(shown.ask, "three different groups, in order").toHaveLength(3);
    expect(new Set(shown.ask).size).toBe(3);
    expect(shown.ask).toEqual([...shown.ask].sort((x, y) => x - y));
    expect(shown.ask.every((group) => group >= 1 && group <= 14)).toBe(true);
    expect(shown.wrong, "none wrong before a try").toEqual([]);
    expect(device.holder.keys(), "still locked").toBeNull();
    expect(device.log.to("POST wrap"), "nothing sent yet").toEqual([]);
    expect(await wrapsOnServer(), "and the server holds no vault").toMatchObject({ vaultId: null, wraps: [] });

    // The first try is wrong, the second is right (small letters and spaces do not matter).
    device.setup.typeBack(groupsAskedWithASlip(shown));
    const second = at(device, "show-key");
    expect(second.wrong, "the slipped group is named, by its number").toEqual([shown.ask[0]]);
    expect(second.message, "told in plain words").toBe(SETUP_WORDS.typeBackWrong);
    expect(second.recoveryKey, "the same key is still shown").toBe(shown.recoveryKey);
    expect(second.ask, "and the same groups are asked").toEqual(shown.ask);
    expect(device.log.to("POST wrap"), "a wrong try sends nothing").toEqual([]);
    expect(device.holder.keys()).toBeNull();

    device.setup.typeBack(` ${groupsAsked(shown).toLowerCase().replace(/(.{4})/g, "$1 ")}`);
    expect(device.setup.state, "right: on to the password step").toEqual({ step: "choose-password", message: null });
    expect(device.log.to("POST wrap"), "still nothing sent: the password step comes first").toEqual([]);
    expect(device.holder.keys(), "and still locked").toBeNull();

    await device.setup.finishSetup(null);
    expect(device.setup.state, "no password asked for, none kept").toEqual({ step: "set-up", password: false, message: null });
    expect(device.holder.isUnlocked).toBe(true);

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

    device.setup.done();
    expect(device.setup.state).toEqual({ step: "unlocked" });

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

  it("lets the person try as often as they need: every wrong try names its groups and sends nothing, and the right one is still right after many", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const first = at(device, "show-key");

    for (let attempt = 0; attempt < 6; attempt++) {
      device.setup.typeBack(attempt % 2 === 0 ? "" : groupsAskedWithASlip(first));
      expect(at(device, "show-key").wrong, `wrong try ${attempt + 1} names the groups`).toEqual(attempt % 2 === 0 ? first.ask : [first.ask[0]]);
    }
    expect(device.log.to("POST wrap"), "nothing was posted").toEqual([]);
    expect(device.holder.keys(), "nothing was unlocked").toBeNull();
    expect(await wrapsOnServer()).toMatchObject({ vaultId: null, wraps: [] });

    device.setup.typeBack(groupsAsked(first));
    expect(device.setup.state.step).toBe("choose-password");

    // A new start (after a cancel) makes a new key.
    device.setup.cancel();
    expect(device.setup.state).toEqual({ step: "locked" });
    await device.setup.begin();
    await device.setup.startFirstRun();
    expect(at(device, "show-key").recoveryKey, "a new key").not.toBe(first.recoveryKey);
  });

  it("names every group that is wrong, and only those: the right ones keep their place", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    const groups = groupsAsked(shown).match(/.{4}/g)!;
    const slip = (group: string) => `${group[0] === "9" ? "8" : "9"}${group.slice(1)}`;
    device.setup.typeBack([slip(groups[0]!), groups[1], slip(groups[2]!)].join(""));
    expect(at(device, "show-key").wrong).toEqual([shown.ask[0], shown.ask[2]]);
    device.setup.typeBack(groups.join("")); // all right now
    expect(device.setup.state.step).toBe("choose-password");
  });

  it("goes back from the password step to the same key and the same groups, and the key is not made again", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    device.setup.typeBack(groupsAsked(shown));
    at(device, "choose-password");
    device.setup.backToKey();
    const again = at(device, "show-key");
    expect(again.recoveryKey).toBe(shown.recoveryKey);
    expect(again.ask).toEqual(shown.ask);
    expect(again.wrong).toEqual([]);
    device.setup.typeBack(groupsAsked(again));
    await device.setup.finishSetup(null);
    expect(at(device, "set-up").password).toBe(false);
    const held = await wrapsOnServer();
    const opened = await unwrapVaultKeyWithRecoveryKey(await parseRecoveryKey(shown.recoveryKey), new Uint8Array(Buffer.from(held.wraps[0].wrap, "base64")), { vaultId: held.vaultId, kid: 1 });
    expect(Array.from(opened), "the key that was shown first is the key that was kept").toEqual(Array.from(device.holder.keys()!.vaultKey));
  });

  it("with a password: sends the Recovery wrap, then the password wrap with the same vault id, and both open to the vault key", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    device.setup.typeBack(groupsAsked(shown));
    await device.setup.finishSetup({ password: "a long password nobody guesses", again: "a long password nobody guesses" });
    expect(device.setup.state).toEqual({ step: "set-up", password: true, message: null });

    const posted = device.log.to("POST wrap");
    expect(posted.map((request) => request.body.kind), "the Recovery wrap first, so the vault id is set").toEqual(["recovery", "password"]);
    expect(posted[1]!.body.vaultId).toBe(posted[0]!.body.vaultId);
    const held = await wrapsOnServer();
    expect(held.wraps.map((wrap: { kind: string }) => wrap.kind).sort()).toEqual(["password", "recovery"]);
    expect(JSON.stringify(held), "the password is not on Nexus").not.toContain("a long password nobody guesses");
    expect(JSON.stringify([device.saved, device.deps.data, device.states]), "nor on the device").not.toContain("a long password nobody guesses");
  }, 30_000);

  it("refuses two passwords that are not the same, or none, and sends nothing; the same words typed on another keyboard agree", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    device.setup.typeBack(groupsAsked(at(device, "show-key")));

    await device.setup.finishSetup({ password: "one long password", again: "another long password" });
    expect(device.setup.state).toEqual({ step: "choose-password", message: SETUP_WORDS.passwordsDiffer });
    await device.setup.finishSetup({ password: "", again: "" });
    expect(device.setup.state, "an empty password is no password").toEqual({ step: "choose-password", message: SETUP_WORDS.passwordsDiffer });
    expect(device.log.to("POST wrap"), "nothing was sent").toEqual([]);
    expect(device.holder.keys()).toBeNull();

    await device.setup.finishSetup({ password: "Ｐassword long enough", again: "Password long enough" }); // a full-width letter and the letter
    expect(device.setup.state).toEqual({ step: "set-up", password: true, message: null });
  }, 30_000);

  it("says so, and still unlocks with the Recovery Key, when Nexus will not keep the password wrap", async () => {
    const device = await setupDevice(world, {}, (next) => async (request) => {
      if (request.url.endsWith("/wrap") && JSON.parse(request.body ?? "{}").kind === "password") throw new Error("offline");
      return next(request);
    });
    await device.setup.begin();
    await device.setup.startFirstRun();
    device.setup.typeBack(groupsAsked(at(device, "show-key")));
    await device.setup.finishSetup({ password: "a long password again", again: "a long password again" });
    expect(device.setup.state).toEqual({ step: "set-up", password: false, message: SETUP_WORDS.passwordNotKept });
    expect(device.holder.isUnlocked, "the vault is set up and unlocked").toBe(true);
    expect((await wrapsOnServer()).wraps.map((wrap: { kind: string }) => wrap.kind)).toEqual(["recovery"]);
  }, 30_000);

  it("keeps the same wrap for another try when Nexus cannot be reached after the password step", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    device.setup.typeBack(groupsAsked(shown));

    device.network.online = false;
    await device.setup.finishSetup(null);
    expect(device.setup.state).toEqual({ step: "save-failed", message: UNREACHABLE });
    expect(device.holder.keys(), "nothing is unlocked without the wrap kept").toBeNull();
    device.setup.typeBack(groupsAsked(shown));
    expect(device.setup.state.step, "typing back again is not what the step takes").toBe("save-failed");

    device.network.online = true;
    await device.setup.tryAgain();
    expect(at(device, "set-up")).toEqual({ step: "set-up", password: false, message: null });
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
    expect(device.setup.state).toEqual({ step: "has-vault", message: SETUP_WORDS.holdsOne, problem: null, hasPassword: false });
    expect(device.states.some((s) => s.step === "show-key")).toBe(false);
    expect(device.log.to("POST wrap")).toEqual([]);
  });

  it("refuses with a plain message and keeps nothing when the server turns out to hold a vault with another vault id", async () => {
    const device = await setupDevice(world);
    await device.setup.begin();
    await device.setup.startFirstRun();
    const shown = at(device, "show-key");
    await sealedVaultOnServer("a-vault-made-meanwhile");

    device.setup.typeBack(groupsAsked(shown));
    await device.setup.finishSetup(null);
    expect(device.setup.state).toEqual({ step: "stopped", reason: "other-vault", message: SETUP_WORDS.otherVault });
    expect(device.holder.keys(), "nothing was unlocked").toBeNull();
    expect((await wrapsOnServer()).vaultId, "and the other vault is as it was").toBe("a-vault-made-meanwhile");
  });

  it("does nothing for a step's event that arrives at another step", async () => {
    const device = await setupDevice(world);
    device.setup.typeBack("ABCD");
    device.setup.backToKey();
    await device.setup.finishSetup(null);
    await device.setup.tryAgain();
    await device.setup.typePassword("anything");
    await device.setup.lookUpDevice("ABCD-EFGH");
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
