// Bytes as text. A device sends an encrypted note, or a wrap, as standard base64 (RFC 4648, with the `=` padding) inside
// JSON. Nexus checks that it is base64 and how long it is, and keeps it as sent. It never opens it: all it reads is
// the header (header.ts).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const VALUES: Readonly<Record<string, number>> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/** How many characters of base64 hold `bytes` bytes. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/**
 * The bytes of a base64 text, or null when it is not base64 exactly as `encode` would write it: other characters, a
 * wrong length, missing or misplaced padding, or spare bits that are not zero. Only one text stands for one set of
 * bytes, so the text that is kept and the bytes that are hashed can never differ.
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const body = text.slice(0, text.length - padding);
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let accumulator = 0;
  let bits = 0;
  let at = 0;
  for (const char of body) {
    const value = VALUES[char];
    if (value === undefined) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (accumulator >> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  // What is left over is the padding's spare bits. Canonical base64 writes them as zero.
  return accumulator === 0 ? out : null;
}
