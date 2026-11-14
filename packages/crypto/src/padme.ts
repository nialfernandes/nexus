import { MIN_PADDED_RECORD_BYTES } from "./constants.js";
import { NexusCryptoError } from "./errors.js";

/** Marks where the record ends inside the padding. */
const END_MARK = 0x80;

/**
 * Padmé: the length a message of `length` bytes is rounded up to, so that the
 * length reveals little (at most about 12% extra, less for larger messages).
 * It keeps the top bits of the length and clears the lowest ones.
 * `length` must be below 2^30.
 */
export function padmeLength(length: number): number {
  if (!Number.isInteger(length) || length < 0 || length >= 2 ** 30) {
    throw new NexusCryptoError("invalid-argument", "length is out of range for Padmé");
  }
  if (length < 2) return length;
  const exponent = 31 - Math.clz32(length); // floor(log2(length))
  const exponentBits = 31 - Math.clz32(exponent) + 1; // floor(log2(exponent)) + 1
  const lowBits = exponent - exponentBits;
  const mask = 2 ** lowBits - 1;
  return (length + mask) & ~mask;
}

/**
 * The record, one end mark (0x80), then zeros up to the Padmé length of the
 * record plus mark, or of MIN_PADDED_RECORD_BYTES if that is more, so a
 * one-line note does not show its length.
 */
export function padRecord(record: Uint8Array): Uint8Array {
  const padded = new Uint8Array(padmeLength(Math.max(record.length + 1, MIN_PADDED_RECORD_BYTES)));
  padded.set(record);
  padded[record.length] = END_MARK;
  return padded;
}

/** Undoes padRecord: drops the trailing zeros and the end mark. Any amount of zeros is accepted. */
export function unpadRecord(padded: Uint8Array): Uint8Array {
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== END_MARK) {
    throw new NexusCryptoError("malformed", "padding has no end mark");
  }
  return padded.subarray(0, end - 1);
}
