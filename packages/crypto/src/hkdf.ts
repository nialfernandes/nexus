import { concatBytes } from "./bytes.js";
import { NexusCryptoError } from "./errors.js";
import type { Sodium } from "./sodium.js";

const HASH_BYTES = 32;

/** HMAC-SHA-256 using libsodium's incremental interface, which takes a key of any length. */
export function hmacSha256(sodium: Sodium, key: Uint8Array, message: Uint8Array): Uint8Array {
  const state = sodium.crypto_auth_hmacsha256_init(key);
  sodium.crypto_auth_hmacsha256_update(state, message);
  return sodium.crypto_auth_hmacsha256_final(state);
}

/**
 * HKDF-SHA-256 as RFC 5869 describes it, built from libsodium's HMAC because
 * libsodium.js does not expose its own HKDF. An empty salt means HashLen zero
 * bytes, as the RFC says.
 */
export function hkdfSha256(
  sodium: Sodium,
  inputKey: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 255 * HASH_BYTES) {
    throw new NexusCryptoError("invalid-argument", "HKDF output length is out of range");
  }
  const pseudoRandomKey = hmacSha256(sodium, salt.length === 0 ? new Uint8Array(HASH_BYTES) : salt, inputKey);
  const output = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1, filled = 0; filled < length; counter++) {
    previous = hmacSha256(sodium, pseudoRandomKey, concatBytes(previous, info, Uint8Array.of(counter)));
    output.set(previous.subarray(0, Math.min(HASH_BYTES, length - filled)), filled);
    filled += HASH_BYTES;
  }
  sodium.memzero(pseudoRandomKey);
  return output;
}
