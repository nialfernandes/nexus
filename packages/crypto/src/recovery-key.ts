import { concatBytes, utf8 } from "./bytes.js";
import { KEY_BYTES, RECOVERY_ALPHABET, RECOVERY_CHECK_LABEL } from "./constants.js";
import { NexusCryptoError } from "./errors.js";
import { loadSodium, type Sodium } from "./sodium.js";

/** 256 bits written 5 bits at a time: 52 symbols, the last one carrying a single bit. */
const KEY_SYMBOLS = 52;
const CHECK_SYMBOLS = 4;
const GROUP_SIZE = 4;
const BITS_PER_SYMBOL = 5;

/** A new Recovery Key: 256 random bits. */
export async function generateRecoveryKey(): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sodium.randombytes_buf(KEY_BYTES);
}

/**
 * Writes a Recovery Key as text a person can copy by hand: 52 symbols for the
 * key and 4 check symbols, in 14 groups of 4 joined by hyphens.
 */
export async function formatRecoveryKey(recoveryKey: Uint8Array): Promise<string> {
  const sodium = await loadSodium();
  if (!(recoveryKey instanceof Uint8Array) || recoveryKey.length !== KEY_BYTES) {
    throw new NexusCryptoError("invalid-argument", `recoveryKey must be a Uint8Array of ${KEY_BYTES} bytes`);
  }
  const symbols = symbolsFromBits(recoveryKey, KEY_SYMBOLS) + checkSymbols(sodium, recoveryKey);
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP_SIZE) groups.push(symbols.slice(i, i + GROUP_SIZE));
  return groups.join("-");
}

/**
 * Reads what formatRecoveryKey wrote. Capitals or small letters, hyphens,
 * spaces and line breaks do not matter, and O reads as 0, I and L as 1.
 * Anything else that is wrong throws "bad-recovery-key".
 */
export async function parseRecoveryKey(text: string): Promise<Uint8Array> {
  const sodium = await loadSodium();
  if (typeof text !== "string") {
    throw new NexusCryptoError("bad-recovery-key", "the Recovery Key must be text");
  }
  const symbols = normalise(text);
  if (symbols.length !== KEY_SYMBOLS + CHECK_SYMBOLS) {
    throw new NexusCryptoError(
      "bad-recovery-key",
      `the Recovery Key has ${symbols.length} characters; it should have ${KEY_SYMBOLS + CHECK_SYMBOLS}`,
    );
  }
  const values = Array.from(symbols, (symbol, index) => {
    const value = RECOVERY_ALPHABET.indexOf(symbol);
    if (value < 0) {
      throw new NexusCryptoError("bad-recovery-key", `character ${index + 1} is not part of the Recovery Key alphabet`);
    }
    return value;
  });
  const key = bitsFromSymbols(values.slice(0, KEY_SYMBOLS));
  if (key === null || symbols.slice(KEY_SYMBOLS) !== checkSymbols(sodium, key)) {
    throw new NexusCryptoError("bad-recovery-key", "the check characters do not match: a character was mistyped");
  }
  return key;
}

function normalise(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function symbolsFromBits(bytes: Uint8Array, count: number): string {
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

/** The reverse of symbolsFromBits for the 52 key symbols; null if the unused low 4 bits are not zero. */
function bitsFromSymbols(values: number[]): Uint8Array | null {
  const out = new Uint8Array(KEY_BYTES);
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const value of values) {
    buffer = (buffer << BITS_PER_SYMBOL) | value;
    bits += BITS_PER_SYMBOL;
    if (bits >= 8) {
      bits -= 8;
      if (written < KEY_BYTES) out[written++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? out : null;
}

/** The first 20 bits of SHA-256(label, key), as 4 symbols. */
function checkSymbols(sodium: Sodium, key: Uint8Array): string {
  const digest = sodium.crypto_hash_sha256(concatBytes(utf8(RECOVERY_CHECK_LABEL), key));
  return symbolsFromBits(digest, CHECK_SYMBOLS);
}
