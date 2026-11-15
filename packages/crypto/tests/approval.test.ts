import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  approvalCode, deviceKeyCode, generateDeviceKeyPair, generateVaultKey, NexusCryptoError, openApproval, readApprovalCode, RECOVERY_ALPHABET, sealApproval,
} from "../src/index.js";
import { APPROVAL_CODE_TEXT, DEVICE_KEY_CODE_TEXT, VAULT_CONTEXT, VAULT_ID, VAULT_KEY } from "./fixtures.js";
import { filled, flipBit, sequence, toHex } from "./helpers.js";

async function refusal(promise: Promise<unknown>): Promise<NexusCryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NexusCryptoError);
    return error as NexusCryptoError;
  }
  throw new Error("expected the call to be refused");
}

describe("sealed approvals", () => {
  it("give the vault key and the kid to the device they were sealed to", async () => {
    const device = await generateDeviceKeyPair();
    const vaultKey = await generateVaultKey();
    const sealed = await sealApproval(device.publicKey, vaultKey, { ...VAULT_CONTEXT, kid: 7 });
    const opened = await openApproval(device, sealed, { vaultId: VAULT_ID });
    expect(toHex(opened.vaultKey)).toBe(toHex(vaultKey));
    expect(opened.kid).toBe(7);
  });

  it("make a key pair of 32-byte X25519 keys, new each time", async () => {
    const a = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    expect(a.publicKey.length).toBe(32);
    expect(a.privateKey.length).toBe(32);
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey));
  });

  it("cannot be opened by another device", async () => {
    const device = await generateDeviceKeyPair();
    const other = await generateDeviceKeyPair();
    const sealed = await sealApproval(device.publicKey, VAULT_KEY, VAULT_CONTEXT);
    expect((await refusal(openApproval(other, sealed, { vaultId: VAULT_ID }))).code).toBe("unwrap-failed");
  });

  it("are refused for another vault, with the vault named in the code", async () => {
    const device = await generateDeviceKeyPair();
    const sealed = await sealApproval(device.publicKey, VAULT_KEY, VAULT_CONTEXT);
    expect((await refusal(openApproval(device, sealed, { vaultId: "vault-2" }))).code).toBe("wrong-vault");
  });

  it("are refused when any bit is flipped or the approval is cut short", async () => {
    const device = await generateDeviceKeyPair();
    const sealed = await sealApproval(device.publicKey, VAULT_KEY, VAULT_CONTEXT);
    for (let index = 0; index < sealed.length; index++) {
      expect((await refusal(openApproval(device, flipBit(sealed, index, index % 8), { vaultId: VAULT_ID }))).code, `byte ${index}`).toBe("unwrap-failed");
    }
    expect((await refusal(openApproval(device, sealed.slice(0, 47), { vaultId: VAULT_ID }))).code).toBe("truncated");
    expect((await refusal(openApproval(device, sealed.slice(0, 60), { vaultId: VAULT_ID }))).code).toBe("unwrap-failed");
  });

  it("refuse keys of the wrong size", async () => {
    expect((await refusal(sealApproval(new Uint8Array(31), VAULT_KEY, VAULT_CONTEXT))).code).toBe("invalid-argument");
    const device = await generateDeviceKeyPair();
    expect((await refusal(sealApproval(device.publicKey, new Uint8Array(31), VAULT_CONTEXT))).code).toBe("invalid-argument");
  });
});

describe("an approval opened with no vault id named", () => {
  it("tells the new device which vault it is for, as well as the key and the kid", async () => {
    const device = await generateDeviceKeyPair();
    const sealed = await sealApproval(device.publicKey, VAULT_KEY, { vaultId: "a vault the device had not heard of", kid: 3 });
    const opened = await openApproval(device, sealed);
    expect(opened.vaultId).toBe("a vault the device had not heard of");
    expect(opened.kid).toBe(3);
    expect(toHex(opened.vaultKey)).toBe(toHex(VAULT_KEY));
  });

  it("still refuses an approval for another vault when one is named", async () => {
    const device = await generateDeviceKeyPair();
    const sealed = await sealApproval(device.publicKey, VAULT_KEY, VAULT_CONTEXT);
    expect((await refusal(openApproval(device, sealed, { vaultId: "vault-2" }))).code).toBe("wrong-vault");
    expect((await openApproval(device, sealed, { vaultId: VAULT_ID })).vaultId).toBe(VAULT_ID);
  });
});

/** The pieces of one approval: the new device's key, the approving device's key, and the approval the approver sealed. */
async function anApproval(vaultKey = VAULT_KEY, kid = 1) {
  const newDevice = await generateDeviceKeyPair();
  const approver = await generateDeviceKeyPair();
  const sealed = await sealApproval(newDevice.publicKey, vaultKey, { vaultId: VAULT_ID, kid });
  return { newDevice, approver, sealed, kid };
}

describe("the matching code of an approval", () => {
  it("is ten symbols of the Recovery Key's alphabet in two groups of five, and the same for the same approval", async () => {
    const { newDevice, approver, sealed, kid } = await anApproval();
    const code = await approvalCode({ newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed });
    expect(code).toMatch(new RegExp(`^[${RECOVERY_ALPHABET}]{5}-[${RECOVERY_ALPHABET}]{5}$`));
    expect(await approvalCode({ newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed })).toBe(code);
  });

  it("is what a second implementation written from docs/FORMAT.md makes from the same bytes", async () => {
    const newDevicePublicKey = sequence(32, 0x10);
    const approverPublicKey = sequence(32, 0x50);
    const sealed = sequence(91, 0x90);
    const kid = 0x01020304;
    const digest = sha256(Uint8Array.from([
      ...new TextEncoder().encode("nexus v1 approval code"), ...newDevicePublicKey, ...approverPublicKey, 1, 2, 3, 4, ...sha256(sealed),
    ]));
    const symbols = Array.from({ length: 10 }, (_, index) => {
      const bit = index * 5;
      const window = (digest[bit >> 3]! << 8) | digest[(bit >> 3) + 1]!;
      return RECOVERY_ALPHABET[(window >> (11 - (bit & 7))) & 31];
    }).join("");
    expect(await approvalCode({ newDevicePublicKey, approverPublicKey, kid, sealed })).toBe(`${symbols.slice(0, 5)}-${symbols.slice(5)}`);
  });

  it("is the code docs/FORMAT.md works out from the same bytes", async () => {
    expect(await approvalCode({ newDevicePublicKey: sequence(32, 0x10), approverPublicKey: sequence(32, 0x50), kid: 1, sealed: sequence(91, 0x90) })).toBe(APPROVAL_CODE_TEXT);
  });

  it("changes when the approval is swapped for one the server sealed to the same device with a key of its own", async () => {
    const { newDevice, approver, sealed, kid } = await anApproval();
    const serversKey = await generateVaultKey();
    const swapped = await sealApproval(newDevice.publicKey, serversKey, { vaultId: VAULT_ID, kid });
    const real = await approvalCode({ newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed });
    const forged = await approvalCode({ newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed: swapped });
    expect(forged).not.toBe(real);
    // Even the same key sealed again is another approval, with another code: the code commits to the sealed bytes.
    const again = await sealApproval(newDevice.publicKey, VAULT_KEY, { vaultId: VAULT_ID, kid });
    expect(await approvalCode({ newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed: again })).not.toBe(real);
  });

  it("changes when either device's key, the kid or any byte of the approval changes", async () => {
    const { newDevice, approver, sealed, kid } = await anApproval();
    const other = await generateDeviceKeyPair();
    const base = { newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed };
    const real = await approvalCode(base);
    expect(await approvalCode({ ...base, newDevicePublicKey: other.publicKey }), "another new device's key").not.toBe(real);
    expect(await approvalCode({ ...base, approverPublicKey: other.publicKey }), "another approver's key").not.toBe(real);
    expect(await approvalCode({ ...base, kid: kid + 1 }), "another kid").not.toBe(real);
    for (const index of [0, 31, 32, 47, 48, sealed.length - 1]) {
      expect(await approvalCode({ ...base, sealed: flipBit(sealed, index) }), `sealed byte ${index}`).not.toBe(real);
    }
    // The two keys are not interchangeable: swapping which is which is another code.
    expect(await approvalCode({ ...base, newDevicePublicKey: approver.publicKey, approverPublicKey: newDevice.publicKey })).not.toBe(real);
  });

  it("refuses inputs of the wrong size", async () => {
    const { newDevice, approver, sealed, kid } = await anApproval();
    const base = { newDevicePublicKey: newDevice.publicKey, approverPublicKey: approver.publicKey, kid, sealed };
    expect((await refusal(approvalCode({ ...base, newDevicePublicKey: new Uint8Array(31) }))).code).toBe("invalid-argument");
    expect((await refusal(approvalCode({ ...base, approverPublicKey: filled(33, 1) }))).code).toBe("invalid-argument");
    expect((await refusal(approvalCode({ ...base, kid: -1 }))).code).toBe("invalid-argument");
    expect((await refusal(approvalCode({ ...base, sealed: new Uint8Array(0) }))).code).toBe("invalid-argument");
  });

  it("has a code for the new device's key alone, which the approving device checks before it seals anything", async () => {
    const key = sequence(32, 0x10);
    const digest = sha256(Uint8Array.from([...new TextEncoder().encode("nexus v1 device key code"), ...key]));
    const symbols = Array.from({ length: 10 }, (_, index) => {
      const bit = index * 5;
      const window = (digest[bit >> 3]! << 8) | digest[(bit >> 3) + 1]!;
      return RECOVERY_ALPHABET[(window >> (11 - (bit & 7))) & 31];
    }).join("");
    const code = await deviceKeyCode(key);
    expect(code, "a second implementation written from docs/FORMAT.md").toBe(`${symbols.slice(0, 5)}-${symbols.slice(5)}`);
    expect(code, "the pinned example").toBe(DEVICE_KEY_CODE_TEXT);
    expect(await deviceKeyCode(key)).toBe(code);
    expect(await deviceKeyCode(sequence(32, 0x11)), "another key, another code").not.toBe(code);
    expect(code, "and it is not the matching code of anything made from the key").not.toBe(
      await approvalCode({ newDevicePublicKey: key, approverPublicKey: sequence(32, 0x50), kid: 1, sealed: sequence(91, 0x90) }),
    );
    expect((await refusal(deviceKeyCode(new Uint8Array(31)))).code).toBe("invalid-argument");
  });

  it("is read from what a person typed: capitals or small letters, hyphen or space, O for 0 and I or L for 1; anything else is null", () => {
    expect(readApprovalCode("7k3m9-0b1xt")).toBe("7K3M9-0B1XT");
    expect(readApprovalCode(" 7K3M9 oBLXT ")).toBe("7K3M9-0B1XT");
    expect(readApprovalCode("7K3M90B1XT")).toBe("7K3M9-0B1XT");
    expect(readApprovalCode("7K3M9-0B1X")).toBeNull();
    expect(readApprovalCode("7K3M9-0B1XTT")).toBeNull();
    expect(readApprovalCode("7K3M9-0B1XU")).toBeNull();
    expect(readApprovalCode("")).toBeNull();
  });
});
