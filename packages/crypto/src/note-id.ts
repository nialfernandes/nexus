import { requireBytes, requireId, utf8 } from "./bytes.js";
import { KEY_BYTES, NOTE_ID_BYTES, NOTE_ID_KDF_LABEL } from "./constants.js";
import { hkdfSha256, hmacSha256 } from "./hkdf.js";
import { loadSodium } from "./sodium.js";

/**
 * The id of a note made from a key the caller can make again (docs/FORMAT.md section 7.6): the same key gives the same id in this
 * vault, so a writer whose answer was lost can make the same note again and find it there. The server sees the id, so the id must say
 * nothing about the key: it is the first 16 bytes of HMAC-SHA-256, under a key HKDF derives from the vault key, of the key's UTF-8
 * bytes, written as url-safe base64 without padding (22 characters). Without the vault key the server cannot tell what key an id was
 * made from, nor check a guess. The key is 1 to 1024 UTF-8 bytes and well formed, as any id is (`invalid-argument` otherwise).
 */
export async function noteIdFromKey(vaultKey: Uint8Array, key: string): Promise<string> {
  const sodium = await loadSodium();
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  requireId(key, "key");
  const idKey = hkdfSha256(sodium, vaultKey, new Uint8Array(0), utf8(NOTE_ID_KDF_LABEL), KEY_BYTES);
  try {
    return sodium.to_base64(hmacSha256(sodium, idKey, utf8(key)).slice(0, NOTE_ID_BYTES), sodium.base64_variants.URLSAFE_NO_PADDING);
  } finally {
    sodium.memzero(idKey);
  }
}
