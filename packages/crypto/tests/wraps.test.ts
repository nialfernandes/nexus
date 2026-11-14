import { describe, expect, it } from "vitest";
import {
  createPasswordWrap,
  generateRecoveryKey,
  generateVaultKey,
  NexusCryptoError,
  openPasswordWrap,
  unwrapVaultKeyWithRecoveryKey,
  wrapVaultKeyWithRecoveryKey,
} from "../src/index.js";
import { PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES, sealPasswordWrap } from "../src/wraps.js";
import { loadSodium } from "../src/sodium.js";
import {
  NONCE, PASSWORD, PASSWORD_WRAP_HEX, RECOVERY_KEY, RECOVERY_WRAP_HEX, SALT, VAULT_CONTEXT, VAULT_KEY,
} from "./fixtures.js";
import { flipBit, fromHex, toHex } from "./helpers.js";

async function refusal(promise: Promise<unknown>): Promise<NexusCryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NexusCryptoError);
    return error as NexusCryptoError;
  }
  throw new Error("expected the call to be refused");
}

describe("recovery wrap", () => {
  it("gives the vault key back to the same Recovery Key", async () => {
    const recoveryKey = await generateRecoveryKey();
    const vaultKey = await generateVaultKey();
    const wrap = await wrapVaultKeyWithRecoveryKey(recoveryKey, vaultKey, VAULT_CONTEXT);
    expect(wrap.length).toBe(RECOVERY_WRAP_BYTES);
    expect(Array.from(wrap.slice(0, 2))).toEqual([1, 2]);
    expect(toHex(await unwrapVaultKeyWithRecoveryKey(recoveryKey, wrap, VAULT_CONTEXT))).toBe(toHex(vaultKey));
  });

  it("reads the pinned wrap from docs/FORMAT.md", async () => {
    const opened = await unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, fromHex(RECOVERY_WRAP_HEX), VAULT_CONTEXT);
    expect(toHex(opened)).toBe(toHex(VAULT_KEY));
  });

  it("refuses a wrong Recovery Key with 'unwrap-failed'", async () => {
    const wrap = fromHex(RECOVERY_WRAP_HEX);
    const error = await refusal(unwrapVaultKeyWithRecoveryKey(await generateRecoveryKey(), wrap, VAULT_CONTEXT));
    expect(error.code).toBe("unwrap-failed");
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(flipBit(RECOVERY_KEY, 0), wrap, VAULT_CONTEXT))).code).toBe("unwrap-failed");
  });

  it("refuses another vault id or kid", async () => {
    const wrap = fromHex(RECOVERY_WRAP_HEX);
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, wrap, { ...VAULT_CONTEXT, vaultId: "vault-2" }))).code).toBe("unwrap-failed");
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, wrap, { ...VAULT_CONTEXT, kid: 2 }))).code).toBe("unwrap-failed");
  });

  it("refuses any flipped bit after the header, a truncated wrap, a longer wrap and a wrong version or kind", async () => {
    const wrap = fromHex(RECOVERY_WRAP_HEX);
    for (let index = 2; index < wrap.length; index++) {
      expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, flipBit(wrap, index, index % 8), VAULT_CONTEXT))).code, `byte ${index}`).toBe("unwrap-failed");
    }
    for (const length of [0, 2, 26, wrap.length - 1]) {
      expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, wrap.slice(0, length), VAULT_CONTEXT))).code).toBe("truncated");
    }
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, new Uint8Array([...wrap, 0]), VAULT_CONTEXT))).code).toBe("malformed");
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, flipBit(wrap, 0), VAULT_CONTEXT))).code).toBe("unsupported-version");
    expect((await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, flipBit(wrap, 1), VAULT_CONTEXT))).code).toBe("malformed");
  });

  it("refuses a password wrap given where a recovery wrap is expected", async () => {
    const error = await refusal(unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, fromHex(PASSWORD_WRAP_HEX).slice(0, RECOVERY_WRAP_BYTES), VAULT_CONTEXT));
    expect(error.code).toBe("malformed");
  });

  it("refuses keys of the wrong size", async () => {
    expect((await refusal(wrapVaultKeyWithRecoveryKey(new Uint8Array(31), VAULT_KEY, VAULT_CONTEXT))).code).toBe("invalid-argument");
    expect((await refusal(wrapVaultKeyWithRecoveryKey(RECOVERY_KEY, new Uint8Array(33), VAULT_CONTEXT))).code).toBe("invalid-argument");
  });
});

describe("password wrap", () => {
  it("gives the vault key back to the same password, and writes the settings beside it", async () => {
    const vaultKey = await generateVaultKey();
    const wrap = await createPasswordWrap(PASSWORD, vaultKey, VAULT_CONTEXT);
    expect(wrap.length).toBe(PASSWORD_WRAP_BYTES);
    // memory 65536 KiB, iterations 3, parallelism 1, each as 4 bytes
    expect(toHex(wrap.slice(0, 14))).toBe("0103000100000000000300000001");
    expect(toHex(await openPasswordWrap(PASSWORD, wrap, VAULT_CONTEXT))).toBe(toHex(vaultKey));
  });

  it("uses a new salt every time", async () => {
    const a = await createPasswordWrap(PASSWORD, VAULT_KEY, VAULT_CONTEXT);
    const b = await createPasswordWrap(PASSWORD, VAULT_KEY, VAULT_CONTEXT);
    expect(toHex(a.slice(14, 30))).not.toBe(toHex(b.slice(14, 30)));
  });

  it("reads the pinned wrap from docs/FORMAT.md", async () => {
    expect(toHex(await openPasswordWrap(PASSWORD, fromHex(PASSWORD_WRAP_HEX), VAULT_CONTEXT))).toBe(toHex(VAULT_KEY));
  });

  it("refuses a wrong password, another vault id and another kid", async () => {
    const wrap = fromHex(PASSWORD_WRAP_HEX);
    expect((await refusal(openPasswordWrap("correct horse battery stapl", wrap, VAULT_CONTEXT))).code).toBe("unwrap-failed");
    expect((await refusal(openPasswordWrap(PASSWORD, wrap, { ...VAULT_CONTEXT, vaultId: "vault-2" }))).code).toBe("unwrap-failed");
    expect((await refusal(openPasswordWrap(PASSWORD, wrap, { ...VAULT_CONTEXT, kid: 2 }))).code).toBe("unwrap-failed");
  });

  it("refuses a flipped bit in the salt or the sealed key (settings are checked first, see below)", async () => {
    const wrap = fromHex(PASSWORD_WRAP_HEX);
    for (const index of [14, 29, 30, 53, 54, 101]) {
      expect((await refusal(openPasswordWrap(PASSWORD, flipBit(wrap, index), VAULT_CONTEXT))).code, `byte ${index}`).toBe("unwrap-failed");
    }
  });

  it("refuses a truncated wrap, a longer wrap and a wrong version or kind", async () => {
    const wrap = fromHex(PASSWORD_WRAP_HEX);
    expect((await refusal(openPasswordWrap(PASSWORD, wrap.slice(0, 101), VAULT_CONTEXT))).code).toBe("truncated");
    expect((await refusal(openPasswordWrap(PASSWORD, new Uint8Array([...wrap, 0]), VAULT_CONTEXT))).code).toBe("malformed");
    expect((await refusal(openPasswordWrap(PASSWORD, flipBit(wrap, 0), VAULT_CONTEXT))).code).toBe("unsupported-version");
    expect((await refusal(openPasswordWrap(PASSWORD, flipBit(wrap, 1), VAULT_CONTEXT))).code).toBe("malformed");
  });

  it("refuses settings outside the limits before doing any key derivation", async () => {
    const wrap = fromHex(PASSWORD_WRAP_HEX);
    const withSetting = (offset: number, value: number) => {
      const copy = wrap.slice();
      new DataView(copy.buffer).setUint32(offset, value, false);
      return copy;
    };
    const tooMuchMemory = withSetting(2, 4 * 1024 * 1024); // 4 GiB
    const tooLittleMemory = withSetting(2, 1024);
    const tooFewPasses = withSetting(6, 1);
    const tooManyPasses = withSetting(6, 13);
    const wrongLanes = withSetting(10, 4);
    for (const bad of [tooMuchMemory, tooLittleMemory, tooFewPasses, tooManyPasses, wrongLanes]) {
      const started = Date.now();
      expect((await refusal(openPasswordWrap(PASSWORD, bad, VAULT_CONTEXT))).code).toBe("unsupported-parameters");
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("refuses to write settings outside the limits", async () => {
    const sodium = await loadSodium();
    const weak = { memoryKiB: 1024, iterations: 1, parallelism: 1 };
    expect(() => sealPasswordWrap(sodium, PASSWORD, VAULT_KEY, VAULT_CONTEXT, weak, SALT, NONCE)).toThrowError(/Argon2id settings/);
  });

  it("refuses an empty password and a password with half a surrogate pair", async () => {
    expect((await refusal(createPasswordWrap("", VAULT_KEY, VAULT_CONTEXT))).code).toBe("invalid-argument");
    expect((await refusal(createPasswordWrap("bad \ud800", VAULT_KEY, VAULT_CONTEXT))).code).toBe("invalid-argument");
  });
});
