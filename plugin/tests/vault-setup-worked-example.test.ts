// The worked example of the setup controller, against the real server code (real-nexus.ts), one person with three things in hand: a
// first device, a second device, and an agent.
//
//   Device A runs the first-run setup (the Recovery Key is shown; three of its groups are typed back wrong, then right; no password) and syncs two
//   notes. Device B is new: it asks to be approved, A approves it with both codes typed (the key code on A, the matching code on B), B
//   unlocks and syncs the two notes. A approves an agent from the agent's public key, and the approval A shows opens in packages/agent,
//   which reads A's notes. Then A locks: its engine says the vault is locked and syncs nothing.

import { generateDeviceKeyPair } from "@nexus/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "../src/base64";
import { AgentVault } from "../../packages/agent/src/index";
import { ADDRESS, fetchOverNexus } from "../../packages/agent/tests/world";
import { at, groupsAsked, groupsAskedWithASlip, setupDevice } from "./setup-world";
import { forbidFetch, openBlob, openWorld, type World } from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the setup controller, worked through", () => {
  it("A sets the vault up and syncs two notes, B is approved from A and syncs them, A approves an agent whose approval reads them, and A locks and syncs nothing", async () => {
    forbidFetch();

    // ── device A: first run ────────────────────────────────────────────────────
    const a = await setupDevice(world, { files: { "Ideas/one.md": "first note\n", "Ideas/two.md": "second note\n" }, name: "Device A" });
    expect(a.engine.status(), "A starts locked").toMatch(/locked/i);
    await a.setup.begin();
    expect(a.setup.state, "Nexus holds no vault").toEqual({ step: "no-vault" });
    await a.setup.startFirstRun();
    const shown = at(a, "show-key");
    expect(a.log.to("POST wrap"), "the key is shown and nothing is sent").toEqual([]);

    a.setup.typeBack(groupsAskedWithASlip(shown)); // the first try is wrong
    expect(at(a, "show-key").wrong).toEqual([shown.ask[0]]);
    expect(a.log.to("POST wrap"), "a wrong try sends nothing").toEqual([]);
    a.setup.typeBack(groupsAsked(shown)); // the second is right
    await a.setup.finishSetup(null); // no password
    a.setup.done();
    expect(a.setup.state).toEqual({ step: "unlocked" });
    expect(a.log.to("POST wrap"), "the wrap went once, with the vault id").toHaveLength(1);
    expect(a.log.to("POST wrap")[0]!.body.vaultId).toBe(a.holder.keys()!.vaultId);

    await a.engine.sync();
    expect(a.log.to("POST save"), "two notes went up").toHaveLength(2);
    const keys = a.holder.keys()!;
    const onNexus = await Promise.all(
      a.log.to("POST save").map(async (seen) => (await openBlob(keys, seen.body.id, seen.body.blob)).path),
    );
    expect(onNexus.sort(), "opened with the key A made").toEqual(["Ideas/one.md", "Ideas/two.md"]);

    // ── device B: approved from A, with both codes typed ───────────────────────
    const b = await setupDevice(world, { token: null, name: "Device B" });
    let matching = "";
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(b, "waiting-for-device"); // B shows the link, the sign-in code and the key code
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.code, waiting.keyCode); // the key code is typed on A
      matching = at(a, "device-approved").code; // A shows the matching code
    };
    await b.setup.askAnotherDevice();
    expect(b.holder.keys(), "B is locked until the matching code is typed on B").toBeNull();
    await b.setup.typeMatchingCode(matching); // the matching code is typed on B
    expect(b.setup.state).toEqual({ step: "device-unlocked" });
    b.setup.done();
    a.setup.done();

    await b.engine.sync();
    expect(b.vault.texts(), "B holds A's notes").toEqual({ "Ideas/one.md": "first note\n", "Ideas/two.md": "second note\n" });

    // ── an agent, approved from its public key ─────────────────────────────────
    const agentKeys = await generateDeviceKeyPair();
    a.setup.startApprovingAgent();
    await a.setup.approveAgent(encodeBase64(agentKeys.publicKey));
    const { approval } = at(a, "agent-approved");
    const agent = await AgentVault.open({
      address: ADDRESS,
      token: await world.tokenFor("agents", "the agent"),
      privateKey: encodeBase64(agentKeys.privateKey),
      approval,
      fetch: fetchOverNexus().fetch,
    });
    expect(await agent.list(), "the agent reads A's notes").toEqual(["Ideas/one.md", "Ideas/two.md"]);
    expect(await agent.read("Ideas/two.md")).toBe("second note\n");
    agent.close();
    a.setup.done();

    // ── A locks ────────────────────────────────────────────────────────────────
    const held = a.holder.keys()!.vaultKey;
    const callsBefore = a.log.requests().length;
    a.setup.lock();
    expect(a.setup.state).toEqual({ step: "locked" });
    expect(held.every((byte) => byte === 0), "the key is overwritten").toBe(true);
    expect(a.engine.status(), "A's engine says the vault is locked").toMatch(/locked/i);
    a.vault.type("Ideas/one.md", "edited while locked\n");
    await a.engine.push("Ideas/one.md");
    await a.engine.sync();
    expect(a.log.requests().length, "and syncs nothing: not one call to Nexus").toBe(callsBefore);
    expect(b.holder.keys(), "B, which has its own copy of the key, is unaffected").not.toBeNull();
  });
});
