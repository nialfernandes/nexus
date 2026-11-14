// A second implementation, written from docs/FORMAT.md using only
// @noble/ciphers and @noble/hashes, decrypts what this package writes and the
// other way round. Nothing here imports the package's own helpers for
// associated data, padding or key derivation: that is the point.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  createPasswordWrap,
  decryptNote,
  encryptNote,
  openPasswordWrap,
  unwrapVaultKeyWithRecoveryKey,
  wrapVaultKeyWithRecoveryKey,
} from "../src/index.js";
import { sealNote } from "../src/note.js";
import { sealPasswordWrap, sealRecoveryWrap } from "../src/wraps.js";
import { loadSodium } from "../src/sodium.js";
import {
  KID, NONCE, NOTE_BLOB_HEX, NOTE_CONTEXT, NOTE_ID, PASSWORD, PASSWORD_WRAP_HEX, RECORD, RECOVERY_KEY,
  RECOVERY_WRAP_HEX, SALT, VAULT_CONTEXT, VAULT_ID, VAULT_KEY,
} from "./fixtures.js";
import { fromHex, toHex } from "./helpers.js";

const text = new TextEncoder();
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const lp = (s: string) => concat(u32(text.encode(s).length), text.encode(s));

/** FORMAT.md, "Associated data". */
const associatedData = (kind: number, vaultId: string, kid: number, subject: string) =>
  concat(Uint8Array.of(1, kind), u32(kid), lp(vaultId), lp(subject));

/** Padmé straight from the paper, using floating-point logarithms (fine for small lengths). */
function padme(length: number): number {
  if (length < 2) return length;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const mask = 2 ** (e - s) - 1;
  return (length + mask) & ~mask;
}

/** FORMAT.md, "Padding": record, 0x80, zeros up to padme(max(len + 1, 256)). */
function pad(record: Uint8Array): Uint8Array {
  const out = new Uint8Array(padme(Math.max(record.length + 1, 256)));
  out.set(record);
  out[record.length] = 0x80;
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  let end = padded.length;
  while (padded[end - 1] === 0) end--;
  expect(padded[end - 1]).toBe(0x80);
  return padded.slice(0, end - 1);
}

const recordBytes = (r: { path: string; text: string }) => text.encode(JSON.stringify({ path: r.path, text: r.text }));

function nobleSealNote(key: Uint8Array, nonce: Uint8Array, vaultId: string, noteId: string, kid: number, r: typeof RECORD) {
  const sealed = xchacha20poly1305(key, nonce, associatedData(1, vaultId, kid, noteId)).encrypt(pad(recordBytes(r)));
  return concat(Uint8Array.of(1), u32(kid), nonce, sealed);
}

describe("note blobs: libsodium writes, noble reads, and the other way round", () => {
  it("noble opens what encryptNote wrote, for records of many sizes", async () => {
    for (const size of [0, 1, 5, 31, 32, 100, 1000, 4097, 70_000]) {
      const record = { path: `Folder/note ${size} ✓.md`, text: "x".repeat(size) };
      const blob = await encryptNote(VAULT_KEY, NOTE_CONTEXT, record);
      expect(Array.from(blob.slice(0, 5))).toEqual([1, 0, 0, 0, KID]);
      const nonce = blob.slice(5, 29);
      const padded = xchacha20poly1305(VAULT_KEY, nonce, associatedData(1, VAULT_ID, KID, NOTE_ID)).decrypt(blob.slice(29));
      expect(padded.length).toBe(padme(Math.max(recordBytes(record).length + 1, 256)));
      expect(JSON.parse(new TextDecoder().decode(unpad(padded)))).toEqual(record);
    }
  });

  it("decryptNote opens what noble wrote", async () => {
    const record = { path: "From/noble.md", text: "written by the other library\n日本語 🌱" };
    const blob = nobleSealNote(VAULT_KEY, NONCE, VAULT_ID, NOTE_ID, KID, record);
    expect(await decryptNote(VAULT_KEY, NOTE_CONTEXT, blob)).toEqual(record);
  });

  it("the pinned blob in FORMAT.md is what noble builds from the fixed inputs, and what libsodium builds", async () => {
    const byNoble = nobleSealNote(VAULT_KEY, NONCE, VAULT_ID, NOTE_ID, KID, RECORD);
    expect(toHex(byNoble)).toBe(NOTE_BLOB_HEX);
    const sodium = await loadSodium();
    expect(toHex(sealNote(sodium, VAULT_KEY, NOTE_CONTEXT, RECORD, NONCE))).toBe(NOTE_BLOB_HEX);
  });
});

describe("recovery wrap: libsodium writes, noble reads, and the other way round", () => {
  const wrapKey = () => hkdf(sha256, RECOVERY_KEY, undefined, text.encode("nexus v1 recovery"), 32);
  const nobleWrap = (nonce: Uint8Array) =>
    concat(Uint8Array.of(1, 2), nonce, xchacha20poly1305(wrapKey(), nonce, associatedData(2, VAULT_ID, KID, "")).encrypt(VAULT_KEY));

  it("noble opens what wrapVaultKeyWithRecoveryKey wrote", async () => {
    const wrap = await wrapVaultKeyWithRecoveryKey(RECOVERY_KEY, VAULT_KEY, VAULT_CONTEXT);
    const opened = xchacha20poly1305(wrapKey(), wrap.slice(2, 26), associatedData(2, VAULT_ID, KID, "")).decrypt(wrap.slice(26));
    expect(toHex(opened)).toBe(toHex(VAULT_KEY));
  });

  it("unwrapVaultKeyWithRecoveryKey opens what noble wrote", async () => {
    const opened = await unwrapVaultKeyWithRecoveryKey(RECOVERY_KEY, nobleWrap(NONCE), VAULT_CONTEXT);
    expect(toHex(opened)).toBe(toHex(VAULT_KEY));
  });

  it("the pinned wrap is what noble builds, and what libsodium builds", async () => {
    expect(toHex(nobleWrap(NONCE))).toBe(RECOVERY_WRAP_HEX);
    const sodium = await loadSodium();
    expect(toHex(sealRecoveryWrap(sodium, RECOVERY_KEY, VAULT_KEY, VAULT_CONTEXT, NONCE))).toBe(RECOVERY_WRAP_HEX);
  });
});

describe("password wrap: libsodium writes, noble reads, and the other way round", () => {
  const params = { t: 3, m: 65_536, p: 1, dkLen: 32 };
  const header = (salt: Uint8Array) => concat(Uint8Array.of(1, 3), u32(65_536), u32(3), u32(1), salt);
  const nobleWrap = (password: string, nonce: Uint8Array, salt: Uint8Array) => {
    const key = argon2id(text.encode(password.normalize("NFKC")), salt, params);
    const head = header(salt);
    const ad = concat(associatedData(3, VAULT_ID, KID, ""), head);
    return concat(head, nonce, xchacha20poly1305(key, nonce, ad).encrypt(VAULT_KEY));
  };

  it("noble opens what createPasswordWrap wrote", async () => {
    const wrap = await createPasswordWrap(PASSWORD, VAULT_KEY, VAULT_CONTEXT);
    const head = wrap.slice(0, 30);
    const key = argon2id(text.encode(PASSWORD), head.slice(14), params);
    const opened = xchacha20poly1305(key, wrap.slice(30, 54), concat(associatedData(3, VAULT_ID, KID, ""), head)).decrypt(wrap.slice(54));
    expect(toHex(opened)).toBe(toHex(VAULT_KEY));
  });

  it("openPasswordWrap opens what noble wrote, and reads the password as NFKC", async () => {
    // "é" typed as one character and as e + combining accent must open the same wrap.
    const composed = "caf\u00e9 au lait";
    const decomposed = "cafe\u0301 au lait";
    expect(composed).not.toBe(decomposed);
    const wrap = nobleWrap(composed, NONCE, SALT);
    expect(toHex(await openPasswordWrap(composed, wrap, VAULT_CONTEXT))).toBe(toHex(VAULT_KEY));
    expect(toHex(await openPasswordWrap(decomposed, wrap, VAULT_CONTEXT))).toBe(toHex(VAULT_KEY));
  });

  it("the pinned wrap is what noble builds, and what libsodium builds", async () => {
    expect(toHex(nobleWrap(PASSWORD, NONCE, SALT))).toBe(PASSWORD_WRAP_HEX);
    const sodium = await loadSodium();
    const made = sealPasswordWrap(sodium, PASSWORD, VAULT_KEY, VAULT_CONTEXT, { memoryKiB: 65_536, iterations: 3, parallelism: 1 }, SALT, NONCE);
    expect(toHex(made)).toBe(PASSWORD_WRAP_HEX);
  });
});

describe("the fixed hex values are real bytes", () => {
  it("parse back to the lengths FORMAT.md states", () => {
    expect(fromHex(RECOVERY_WRAP_HEX).length).toBe(74);
    expect(fromHex(PASSWORD_WRAP_HEX).length).toBe(102);
  });
});
