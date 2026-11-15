// A new device gets the vault key through an approval a server cannot forge. Device A is unlocked and signed in as the owner;
// device B is new: signed out and locked. B asks to be approved, sending its own public key and showing a key code for it. A
// (the person types B's key code on it) seals the vault key to that key and leaves it with Nexus, which holds it for B, hands it
// over once and deletes it. Both devices work out the same matching code, and B puts nothing to use, not the token and not the key,
// until the person types A's code on B and it is the one B worked out. Nothing but the server's routes passes between the two.
//
// The worked example is the first test. The rest are a server that plays hostile (real-nexus.ts `asHostileServer`): it swaps the
// approval for one it sealed with a key of its own, or swaps B's public key for its own before A seals, and neither gets a key into
// B or out of A. The server is the real one; what a hostile one writes into its own tables is sealed here with the real encryption.

import { generateDeviceKeyPair, generateVaultKey, sealApproval } from "@nexus/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalError, MATCHING_CODE_TRIES, approveDevice, signInForKey, type KeySignIn, type PendingApproval } from "../src/approval";
import { encodeBase64 } from "../src/base64";
import { foundIn } from "./leaks";
import {
  DEVICE_NAME, bodyOf, deviceRoutes, emptyNexus, everythingStored, forbidFetch, hostileServer, makeDevice, openWorld, type Device, type World,
} from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TEN_MINUTES = 10 * 60 * 1000;

/** What B's screen shows while it waits. */
interface Screen {
  link: string;
  code: string;
  keyCode: string;
}

/** A new device: signed out, locked, no notes. */
const newDevice = (name = "New phone"): Promise<Device> => makeDevice(world, { token: null, unlock: null, name });

/** Device A: unlocked with the vault key, signed in as the owner, holding two notes (pushed to Nexus). */
async function deviceA(): Promise<Device> {
  const a = await makeDevice(world, { files: { "Ideas/one.md": "first note\n", "Ideas/two.md": "second note\n" }, name: "Device A" });
  await a.engine.sync();
  return a;
}

const approver = (a: Device) => ({ http: a.deps.http, data: a.deps.data, unlock: a.unlock });

/**
 * B asks to be approved. `during` is called each time B waits to poll, with B's screen: the person doing what they do on the other
 * device. The sign-in returns when B has its answer.
 */
async function asksToBeApproved(b: Device, during: (screen: Screen, wait: number) => Promise<void>): Promise<{ outcome: KeySignIn; screen: Screen }> {
  const screens: Screen[] = [];
  let waits = 0;
  const outcome = await signInForKey({
    http: b.deps.http,
    data: b.deps.data,
    persist: b.deps.persist,
    device: DEVICE_NAME,
    show: (link, code, keyCode) => screens.push({ link, code, keyCode: keyCode ?? "" }),
    open: () => undefined,
    wait: async () => {
      expect(waits, "B is still waiting: it polls, it does not give up").toBeLessThan(6);
      await during(screens[0]!, waits++);
    },
    unlock: b.unlock,
  });
  return { outcome, screen: screens[0]! };
}

const checkCode = (outcome: KeySignIn): PendingApproval => {
  expect(outcome.result).toBe("check-code");
  return (outcome as { approval: PendingApproval }).approval;
};

const hasToken = (b: Device): boolean => b.saved.some((data) => data.token !== null) || b.deps.data.token !== null;

describe("device A approves a new device B", () => {
  it("worked example: B asks, A approves, both work out the same code, B confirms, opens the approval and syncs A's notes", async () => {
    const a = await deviceA();
    const b = await newDevice();
    expect(b.unlock.keys(), "B starts locked").toBeNull();

    let approved: { code: string; label: string } | undefined;
    const { outcome, screen } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait !== 0) return;
      // B has shown its link, its sign-in code and the code of its key. The person types the sign-in code and B's key code on A.
      expect(shown.keyCode, "B shows a code for its own key").toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      approved = await approveDevice(approver(a), shown.code, shown.keyCode);
    });

    expect(approved, "A worked out a matching code").toMatchObject({ label: DEVICE_NAME });
    const pending = checkCode(outcome);
    expect(pending.code, "B works out the same code as A").toBe(approved!.code);
    expect(approved!.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(screen.code, "the code B showed with its link is the sign-in's, not the matching code").not.toBe(approved!.code);

    // B has the approval but uses nothing of it yet.
    expect(b.unlock.keys(), "still locked until the person confirms").toBeNull();
    expect(hasToken(b), "and no token kept either").toBe(false);
    expect(hostileServer().approvalsHeld(screen.code), "Nexus deleted the approval as B collected it").toBe(0);

    // The person types, on B, the code A shows.
    expect(await pending.confirm(approved!.code)).toBe("unlocked");
    const keys = b.unlock.keys();
    expect(keys, "B is unlocked with the vault's key, id and kid").toMatchObject({ vaultId: world.keys.vaultId, kid: world.keys.kid });
    expect(Array.from(keys!.vaultKey)).toEqual(Array.from(world.keys.vaultKey));
    expect(b.deps.data.token, "and signed in").toMatch(/^nx_/);

    // B syncs A's notes.
    await b.engine.sync();
    expect(b.vault.texts(), "B holds what A had").toEqual({ "Ideas/one.md": "first note\n", "Ideas/two.md": "second note\n" });
    expect(b.engine.status()).not.toMatch(/locked|signed out/i);

    // Nothing of the key or the approval was written down anywhere on B, or is still on the server.
    const written = JSON.stringify(b.saved);
    expect(written).not.toContain(encodeBase64(world.keys.vaultKey));
    expect(everythingStored()).not.toContain(encodeBase64(world.keys.vaultKey));
    expect(await pending.confirm(approved!.code), "an approval is used once").toBe("closed");
  });

  it("leaves the vault key, the approval and the device's private key in nothing the new device keeps, shows, sends on or logs", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(" ")));
    }
    const a = await deviceA();
    const b = await newDevice();
    let held: { approval: string; approverKey: string } | null = null;
    let approved!: { code: string };
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait !== 0) return;
      approved = await approveDevice(approver(a), shown.code, shown.keyCode);
      held = hostileServer().approvalFor(shown.code);
    });
    await checkCode(outcome).confirm(approved.code);
    await b.engine.sync();
    expect(b.unlock.keys()).not.toBeNull();

    const bytes = Buffer.from(world.keys.vaultKey);
    const needles = [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url"), JSON.stringify(Array.from(world.keys.vaultKey)), held!.approval];
    for (const [what, text] of [
      ["the data B persisted", JSON.stringify(b.saved)],
      ["the data B holds", JSON.stringify(b.deps.data)],
      ["B's vault", JSON.stringify(b.vault.texts())],
      ["what B sent to Nexus", JSON.stringify(b.log.requests().map((r) => ({ ...r, answer: undefined })))],
      ["B's notices and status", JSON.stringify([...b.notices, b.engine.status()])],
      ["what was logged", logged.join("\n")],
    ] as const) {
      expect(foundIn(text, needles), `${what} holds no part of the vault key or the approval`).toEqual([]);
    }
  });

  it("is read from what a person typed: small letters and a space for the hyphen are the same code", async () => {
    const a = await deviceA();
    const b = await newDevice();
    let approved!: { code: string };
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) approved = await approveDevice(approver(a), shown.code, shown.keyCode.toLowerCase().replace("-", " "));
    });
    expect(await checkCode(outcome).confirm(approved.code.toLowerCase().replace("-", " "))).toBe("unlocked");
  });

  it("closes after three wrong codes, as a refusal does: the right code is then too late, and no key or token was kept", async () => {
    const a = await deviceA();
    const b = await newDevice();
    let approved!: { code: string };
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) approved = await approveDevice(approver(a), shown.code, shown.keyCode);
    });
    const pending = checkCode(outcome);
    expect(MATCHING_CODE_TRIES).toBe(3);
    const other = approved.code === "00000-00000" ? "11111-11111" : "00000-00000";
    for (const left of [2, 1, 0]) {
      expect(await pending.confirm(other)).toBe("mismatch");
      expect(pending.triesLeft).toBe(left);
    }
    expect(await pending.confirm(approved.code), "the right code after the third wrong one").toBe("closed");
    expect(await pending.confirm(other), "and a wrong one").toBe("closed");
    expect(b.unlock.keys()).toBeNull();
    expect(hasToken(b), "no token was kept").toBe(false);
  });

  it("is not unlocked by a wrong code, which leaves the approval waiting for the right one, and a refusal forgets everything", async () => {
    const a = await deviceA();
    const b = await newDevice();
    let approved!: { code: string };
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) approved = await approveDevice(approver(a), shown.code, shown.keyCode);
    });
    const pending = checkCode(outcome);
    const other = approved.code === "00000-00000" ? "11111-11111" : "00000-00000";
    expect(pending.triesLeft).toBe(MATCHING_CODE_TRIES);
    for (const typed of [other, "not a code"]) {
      expect(await pending.confirm(typed), `typed "${typed}"`).toBe("mismatch");
    }
    expect(pending.triesLeft, "two wrong codes used two tries").toBe(MATCHING_CODE_TRIES - 2);
    expect(b.unlock.keys()).toBeNull();
    expect(hasToken(b)).toBe(false);

    pending.refuse();
    expect(await pending.confirm(approved.code), "the right code after a refusal opens nothing").toBe("closed");
    expect(b.unlock.keys()).toBeNull();
    expect(hasToken(b), "and no token was kept for a device that refused").toBe(false);
  });
});

describe("a server that makes or swaps the approval", () => {
  it("is refused: the approval it sealed with a key of its own opens on B, but its code is not the one A shows", async () => {
    const a = await deviceA();
    const b = await newDevice();
    const server = hostileServer();
    let approved!: { code: string };
    const evilKey = await generateVaultKey();

    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait !== 0) return;
      approved = await approveDevice(approver(a), shown.code, shown.keyCode);
      // Before B polls, the server puts an approval of its own where A's was. It knows B's public key (B sent it), so it can seal to it.
      const deviceKey = server.deviceKeyOf(shown.code)!;
      expect(deviceKey, "the server was given B's public key").toBeTruthy();
      const sealed = await sealApproval(Uint8Array.from(Buffer.from(deviceKey, "base64")), evilKey, { vaultId: world.keys.vaultId, kid: world.keys.kid });
      server.swapApproval(shown.code, Buffer.from(sealed).toString("base64"));
    });

    const pending = checkCode(outcome);
    expect(pending.code, "the codes differ").not.toBe(approved.code);
    // The person looks at A's screen, types A's code on B: it is not B's code, so B refuses and uses nothing.
    expect(await pending.confirm(approved.code)).toBe("mismatch");
    expect(b.unlock.keys(), "B holds no key").toBeNull();
    expect(hasToken(b), "and no token").toBe(false);
    // Even the server's own code, which it can work out, is not what the person is shown on A, so typing A's code never gets it in.
    pending.refuse();
    expect(b.unlock.keys()).toBeNull();
  });

  it("is refused when it swaps only the key it says the approving device has, or only the approval's kid or vault", async () => {
    const a = await deviceA();
    const server = hostileServer();
    const other = await generateDeviceKeyPair();
    for (const [what, swap] of [
      ["the approving device's key", async (code: string) => server.swapApproval(code, server.approvalFor(code)!.approval, Buffer.from(other.publicKey).toString("base64"))],
      ["a byte of the approval", async (code: string) => {
        const sealed = Buffer.from(server.approvalFor(code)!.approval, "base64");
        sealed[sealed.length - 1] ^= 1;
        server.swapApproval(code, sealed.toString("base64"));
      }],
    ] as const) {
      const b = await newDevice(what);
      let approved!: { code: string };
      const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
        if (wait !== 0) return;
        approved = await approveDevice(approver(a), shown.code, shown.keyCode);
        await swap(shown.code);
      });
      if (outcome.result === "bad-approval") {
        expect(b.unlock.keys(), `${what}: a damaged approval does not open`).toBeNull();
      } else {
        expect(await checkCode(outcome).confirm(approved.code), what).toBe("mismatch");
        expect(b.unlock.keys(), what).toBeNull();
      }
      expect(hasToken(b), `${what}: no token`).toBe(false);
    }
  });

  it("cannot get the vault key out of A by putting its own public key where B's was: A seals nothing for a key whose code is not B's", async () => {
    const a = await deviceA();
    const b = await newDevice();
    const server = hostileServer();
    const serversPair = await generateDeviceKeyPair();
    let refused: unknown;
    let sent = 0;
    let signInCode = "";

    await expect(
      asksToBeApproved(b, async (shown, wait) => {
        if (wait > 0) throw new Error("the person gave up");
        // The server answers A's look at the sign-in with a key of its own.
        signInCode = shown.code;
        server.swapDeviceKey(shown.code, Buffer.from(serversPair.publicKey).toString("base64"));
        sent = a.log.requests().length;
        refused = await approveDevice(approver(a), shown.code, shown.keyCode).catch((error) => error);
      }),
    ).rejects.toThrow("the person gave up");

    expect(refused).toBeInstanceOf(ApprovalError);
    expect((refused as ApprovalError).reason).toBe("wrong-key-code");
    expect(a.log.to("POST device/approve"), "A sent no approval at all").toEqual([]);
    expect(a.log.requests().length - sent, "A only looked").toBe(1);
    expect(server.approvalsHeld(signInCode), "so there is nothing sealed to the server's key for it to open").toBe(0);
  });

  it("refuses a code that is not the code of the key it was given, or not a code at all, and says why in plain words", async () => {
    const a = await deviceA();
    const b = await newDevice();
    const reasons: string[] = [];
    let signInCode = "";
    await expect(
      asksToBeApproved(b, async (shown, wait) => {
        if (wait > 0) throw new Error("done");
        signInCode = shown.code;
        for (const typed of ["", "ABCDE-FGHJK", "hello", shown.code]) {
          const error = await approveDevice(approver(a), shown.code, typed).catch((e) => e);
          reasons.push(error instanceof ApprovalError ? error.reason : "approved");
          if (error instanceof ApprovalError) expect(error.message, "plain words").not.toMatch(/\b(401|403|404|http|kid|sealed|X25519)\b/i);
        }
      }),
    ).rejects.toThrow("done");
    expect(reasons, "the sign-in code is not the key code either").toEqual(["wrong-key-code", "wrong-key-code", "wrong-key-code", "wrong-key-code"]);
    expect(hostileServer().approvalsHeld(signInCode)).toBe(0);
  });
});

describe("what A will not do", () => {
  it("send anything when it is locked, signed out, or not the owner's", async () => {
    const b = await newDevice();
    const locked = await deviceA();
    locked.unlock.lock();
    const signedOut = await makeDevice(world, { token: null });
    const agentsToken = await world.tokenFor("agents", "an agent that is not the owner");
    const agent = await makeDevice(world, { token: agentsToken });
    const reasons: Record<string, string> = {};
    const asked = [locked, signedOut, agent].map((device) => device.log.requests().length);
    let signInCode = "";
    await expect(
      asksToBeApproved(b, async (shown, wait) => {
        if (wait > 0) throw new Error("done");
        signInCode = shown.code;
        for (const [name, device] of [["locked", locked], ["signed out", signedOut], ["not the owner", agent]] as const) {
          const error = await approveDevice(approver(device), shown.code, shown.keyCode).catch((e) => e);
          reasons[name] = error instanceof ApprovalError ? error.reason : "approved";
        }
      }),
    ).rejects.toThrow("done");
    expect(reasons).toEqual({ locked: "locked", "signed out": "signed-out", "not the owner": "not-allowed" });
    expect(locked.log.requests().length, "a locked device does not even look").toBe(asked[0]);
    expect(signedOut.log.requests().length, "nor does one that is signed out").toBe(asked[1]);
    expect(agent.log.to("POST device/approve"), "an agent sends no approval").toEqual([]);
    expect(hostileServer().approvalsHeld(signInCode)).toBe(0);
  });

  it("approve a sign-in that is not there, or one that has run out", async () => {
    const a = await deviceA();
    const missing = await approveDevice(approver(a), "NOSUCH-CODE", "AAAAA-AAAAA").catch((e) => e);
    expect(missing).toBeInstanceOf(ApprovalError);
    expect(missing.reason).toBe("no-such-code");

    const b = await newDevice();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    let late: unknown;
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait > 0) return;
      vi.setSystemTime(now + TEN_MINUTES + 1000);
      late = await approveDevice(approver(a), shown.code, shown.keyCode).catch((e) => e);
    });
    expect((late as ApprovalError).reason).toBe("gone");
    expect(outcome, "and B, told the same, gives up").toEqual({ result: "expired" });
  });

  it("give a vault key to a device that did not send a public key, which can still be allowed from the page", async () => {
    const a = await deviceA();
    const started = bodyOf(await deviceRoutes().start(world.user, "a script that sent no key"));
    const error = await approveDevice(approver(a), started.code, "AAAAA-AAAAA").catch((e) => e);
    expect(error).toBeInstanceOf(ApprovalError);
    expect(error.reason).toBe("no-key");
    expect(bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(started.code)).result, "the owner's page can still allow it").toBe("approved");
  });
});

describe("an approval the owner's page allows", () => {
  it("signs B in with no key: it stays locked, and the Recovery Key is the way in", async () => {
    const b = await newDevice();
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(shown.code));
    });
    expect(outcome).toEqual({ result: "signed-in" });
    expect(b.deps.data.token).toMatch(/^nx_/);
    expect(b.unlock.keys()).toBeNull();
  });

  it("is denied, and B keeps nothing", async () => {
    const b = await newDevice();
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).deny(shown.code));
    });
    expect(outcome).toEqual({ result: "denied" });
    expect(hasToken(b)).toBe(false);
  });
});

describe("the approval is deleted", () => {
  it("when B collects it: a second poll with B's secret is told the code is used and holds no approval", async () => {
    const a = await deviceA();
    const pair = await generateDeviceKeyPair();
    const started = bodyOf(await deviceRoutes().start(world.user, "collected once", encodeBase64(pair.publicKey)));
    const { deviceKeyCode } = await import("@nexus/crypto");
    await approveDevice(approver(a), started.code, await deviceKeyCode(pair.publicKey));
    expect(hostileServer().approvalsHeld(started.code)).toBe(1);

    const first = bodyOf(await deviceRoutes().poll(started.secret));
    expect(first.approval, "the first poll is handed it").toEqual(expect.any(String));
    expect(hostileServer().approvalsHeld(started.code)).toBe(0);
    const second = await deviceRoutes().poll(started.secret);
    expect(second.status).toBe(410);
    expect(second.text).not.toContain(first.approval);
  });

  it("after ten minutes when B never collected it: it is not handed over, and the poll deletes it", async () => {
    const a = await deviceA();
    const pair = await generateDeviceKeyPair();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const started = bodyOf(await deviceRoutes().start(world.user, "never collects", encodeBase64(pair.publicKey)));
    const { deviceKeyCode } = await import("@nexus/crypto");
    await approveDevice(approver(a), started.code, await deviceKeyCode(pair.publicKey));
    const held = hostileServer().approvalFor(started.code)!;
    expect(held.approval).toBeTruthy();

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    const late = await deviceRoutes().poll(started.secret);
    expect(late.status).toBe(410);
    expect(late.text).not.toContain(held.approval);
    expect(hostileServer().approvalsHeld(started.code), "deleted, not only hidden").toBe(0);
  });
});

describe("a sign-in that asks for a key is tied to the address it began against", () => {
  it("is dropped when the address changes while B waits: no token and no key are kept", async () => {
    const a = await deviceA();
    const b = await newDevice();
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait !== 0) return;
      await approveDevice(approver(a), shown.code, shown.keyCode);
      b.deps.data.address = "https://another-nexus.example.test/nexus/api";
    });
    expect(outcome).toEqual({ result: "changed" });
    expect(b.unlock.keys()).toBeNull();
    expect(hasToken(b)).toBe(false);
  });

  it("is dropped when the user name changes between the check and the confirm, and the key is not put to use", async () => {
    const a = await deviceA();
    const b = await newDevice();
    let approved!: { code: string };
    const { outcome } = await asksToBeApproved(b, async (shown, wait) => {
      if (wait === 0) approved = await approveDevice(approver(a), shown.code, shown.keyCode);
    });
    const pending = checkCode(outcome);
    b.deps.data.user = "someone-else";
    expect(await pending.confirm(approved.code)).toBe("changed");
    expect(b.unlock.keys()).toBeNull();
    expect(hasToken(b)).toBe(false);
    expect(await pending.confirm(approved.code)).toBe("closed");
  });
});
