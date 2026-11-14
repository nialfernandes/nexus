// The short hash kept with every version: FNV-1a (64 bits) over the text's UTF-8 bytes, as 16 hex characters.
// It tells two versions apart and lets a reader see that a text is the one it expects. It is not a security
// hash and nothing relies on it as one. Written out here, so the logic asks the machine for nothing.

const TWO_32 = 4294967296;
/** The FNV prime is 2^40 + 0x1b3: multiplying by it is a multiply by 0x1b3 plus a shift of 40 bits. */
const PRIME_LOW = 0x1b3;

export function shortHash(text: string): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of new TextEncoder().encode(text)) {
    lo = (lo ^ byte) >>> 0;
    const low = lo * PRIME_LOW;
    const carry = Math.floor(low / TWO_32);
    const shifted = (lo << 8) >>> 0;
    hi = (hi * PRIME_LOW + carry + shifted) % TWO_32;
    lo = low % TWO_32;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
