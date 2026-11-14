import { KEY_BYTES, NONCE_BYTES, TAG_BYTES } from "./constants.js";
import { NexusCryptoError, type NexusCryptoErrorCode } from "./errors.js";
import type { Sodium } from "./sodium.js";

/** XChaCha20-Poly1305: returns the ciphertext with the 16-byte tag after it. */
export function aeadSeal(
  sodium: Sodium,
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES) {
    throw new NexusCryptoError("invalid-argument", "key or nonce has the wrong length");
  }
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData, null, nonce, key);
}

/**
 * Opens what aeadSeal made. The cipher checks the tag before it releases any
 * plaintext, so a failure returns nothing. `failure` is the error code to
 * report: a note and a wrap name their failures differently.
 */
export function aeadOpen(
  sodium: Sodium,
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  sealed: Uint8Array,
  failure: NexusCryptoErrorCode,
): Uint8Array {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES) {
    throw new NexusCryptoError("invalid-argument", "key or nonce has the wrong length");
  }
  if (sealed.length < TAG_BYTES) {
    throw new NexusCryptoError("truncated", "ciphertext is shorter than the authentication tag");
  }
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, associatedData, nonce, key);
  } catch {
    throw new NexusCryptoError(
      failure,
      "could not decrypt: the key or the ids are wrong, or the data was changed",
    );
  }
}
