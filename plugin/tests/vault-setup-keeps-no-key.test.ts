// Through every kind of setup (a first run, an unlock with the Recovery Key, a device approved from another, an agent approved) the vault
// key, the Recovery Key and an agent's approval are written nowhere: not into what a device keeps (its data), not into the vault, not into
// what it sends (the Recovery wrap is the key locked, never the key), not into what Nexus holds, not into a notice, the status line or a
// log. The one place the Recovery Key is shown is the `show-key` step, and the one place an agent's approval is shown is `agent-approved`:
// nothing else a state says holds either. Every secret is searched for in every way it could be written down.

import { generateDeviceKeyPair } from "@nexus/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "../src/base64";
import { foundIn } from "./leaks";
import { at, firstRun, setupDevice } from "./setup-world";
import { everythingStored, forbidFetch, openWorld, type World } from "./world";

let world: World;

beforeEach(async () => {
  world = await openWorld();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A key's bytes in each way they could be written down. */
function bytesShapes(key: Uint8Array): string[] {
  const bytes = Buffer.from(key);
  return [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), JSON.stringify(Array.from(key)), Array.from(key).join(","), JSON.stringify(key)];
}

/** A written Recovery Key in each way a person or a program could write it. */
function textShapes(text: string): string[] {
  return [text, text.toLowerCase(), text.replace(/-/g, ""), text.replace(/-/g, "").toLowerCase(), text.replace(/-/g, " ")];
}

describe("the setup controller, through everything it does", () => {
  it("leaves the vault key, the Recovery Key and an agent's approval in none of what is kept, written, sent, held by Nexus, shown or logged", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(" ")));
    }

    // A first run, with a wrong try on the way.
    const { device: a, recoveryKey } = await firstRun(world, { files: { "Ideas/one.md": "first\n" } });
    await a.engine.sync();
    const keyShapes = bytesShapes(a.holder.keys()!.vaultKey);
    const recoveryShapes = textShapes(recoveryKey);

    // The Recovery Key on a second device that does not unlock it first (a wrong one), then unlocks.
    const second = await setupDevice(world);
    await second.setup.begin();
    await second.setup.typeRecoveryKey("0000-0000");
    await second.setup.typeRecoveryKey(recoveryKey);
    expect(second.setup.state.step).toBe("unlocked");

    // A third, approved from A.
    const third = await setupDevice(world, { token: null });
    let matching = "";
    third.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const waiting = at(third, "waiting-for-device");
      a.setup.startApprovingDevice();
      await a.setup.approveDevice(waiting.keyCode);
      matching = at(a, "device-approved").code;
    };
    await third.setup.askAnotherDevice();
    await third.setup.typeMatchingCode(matching);
    expect(third.setup.state.step).toBe("device-unlocked");
    third.setup.done();
    a.setup.done();

    // An agent.
    const pair = await generateDeviceKeyPair();
    a.setup.startApprovingAgent();
    await a.setup.approveAgent(encodeBase64(pair.publicKey));
    const { approval } = at(a, "agent-approved");
    const approvalShapes = [approval, approval.replace(/=+$/, ""), Buffer.from(approval, "base64").toString("hex")];
    a.setup.done();

    // Everything is searched. A's and the others' states are searched for the vault key only: a state may show the Recovery Key and the approval.
    const devices = [a, second, third];
    const everything = (pick: (device: (typeof devices)[number]) => unknown) => JSON.stringify(devices.map(pick));
    const secrets: Array<[string, string[]]> = [["the vault key", keyShapes], ["the Recovery Key", recoveryShapes], ["the agent's approval", approvalShapes]];
    for (const [name, needles] of secrets) {
      for (const [where, text] of [
        ["the data each device persisted", everything((d) => d.saved)],
        ["the data each device holds", everything((d) => d.deps.data)],
        ["what each device wrote into its vault", everything((d) => d.log.timeline.filter((step) => step.kind !== "request"))],
        ["every file in each vault", everything((d) => d.vault.texts())],
        ["what each device sent, and was answered", everything((d) => d.log.requests())],
        ["what Nexus holds", everythingStored()],
        ["each device's notices and status line", everything((d) => [d.notices, d.engine.status()])],
        ["what was logged", logged.join("\n")],
      ] as const) {
        expect(foundIn(text, needles), `${where} hold no part of ${name}`).toEqual([]);
      }
    }
    for (const [name, needles] of [["the vault key", keyShapes]] as const) {
      expect(foundIn(everything((d) => d.states), needles), `no state holds ${name}`).toEqual([]);
    }

    // The searcher finds each secret where it is shown.
    expect(foundIn(JSON.stringify(a.states), recoveryShapes), "the Recovery Key is in the show-key step").not.toEqual([]);
    expect(foundIn(JSON.stringify(a.states), approvalShapes), "the approval is in the agent-approved step").not.toEqual([]);
    const shownKey = a.states.filter((s) => JSON.stringify(s).includes(recoveryKey));
    expect(shownKey.every((s) => s.step === "show-key"), "and in no other step").toBe(true);
    const shownApproval = a.states.filter((s) => JSON.stringify(s).includes(approval));
    expect(shownApproval.every((s) => s.step === "agent-approved")).toBe(true);
    expect(bytesShapes(new Uint8Array(32).fill(1)).every((shape) => foundIn(`x ${shape} x`, [shape]).length === 1), "the searcher finds a key in each shape").toBe(true);
  });
});
