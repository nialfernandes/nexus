import { describe, expect, it } from "vitest";
import { generateDeviceKeyPair, generateVaultKey, NexusCryptoError, openApproval, sealApproval } from "../src/index.js";
import { VAULT_CONTEXT, VAULT_ID, VAULT_KEY } from "./fixtures.js";
import { flipBit, toHex } from "./helpers.js";

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
