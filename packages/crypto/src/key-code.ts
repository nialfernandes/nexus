// The code a new device shows for its own public key (docs/FORMAT.md section 7.4), written without any encryption library.
// The hashing is not here: the caller hashes `deviceKeyCodeInput(key)` with SHA-256 and hands the digest to `deviceKeyCodeOf`.
// That is how the server, which takes only `@nexus/crypto/format` and has no libsodium, works out the same code a device shows
// for a key (it hands the approval page the code, so the owner can compare it with the new device's screen), and how
// `deviceKeyCode` in approval.ts, which has libsodium, works it out. One place writes the code, so the two cannot differ.

import { APPROVAL_CODE_SYMBOLS, DEVICE_KEY_CODE_LABEL, RECOVERY_ALPHABET } from "./constants.js";

const BITS_PER_SYMBOL = 5;

/** The first `count` symbols of the bytes, five bits each, most significant bit first. */
export function symbolsFromBits(bytes: Uint8Array, count: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  let next = 0;
  for (let i = 0; i < count; i++) {
    while (bits < BITS_PER_SYMBOL) {
      buffer = (buffer << 8) | (next < bytes.length ? bytes[next]! : 0);
      next++;
      bits += 8;
    }
    bits -= BITS_PER_SYMBOL;
    out += RECOVERY_ALPHABET[(buffer >> bits) & 31];
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Ten symbols, in two groups of five. */
export const writeCode = (symbols: string): string => `${symbols.slice(0, APPROVAL_CODE_SYMBOLS / 2)}-${symbols.slice(APPROVAL_CODE_SYMBOLS / 2)}`;

/**
 * What is hashed to make a device's key code: the label, then the public key's bytes. (Made here and not with bytes.ts, which the server
 * does not take: it holds a UTF-8 reader the server's compiler settings do not know.)
 */
export function deviceKeyCodeInput(devicePublicKey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(DEVICE_KEY_CODE_LABEL);
  const out = new Uint8Array(label.length + devicePublicKey.length);
  out.set(label, 0);
  out.set(devicePublicKey, label.length);
  return out;
}

/** The key code, from the SHA-256 digest of `deviceKeyCodeInput(key)`: the first 50 bits as 10 symbols, such as `4TQ8M-W2K0B`. */
export const deviceKeyCodeOf = (digest: Uint8Array): string => writeCode(symbolsFromBits(digest, APPROVAL_CODE_SYMBOLS));
