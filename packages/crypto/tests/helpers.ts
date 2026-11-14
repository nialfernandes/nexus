export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

export function sequence(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
}

/** A copy with one bit flipped. */
export function flipBit(bytes: Uint8Array, index: number, bit = 0): Uint8Array {
  const copy = bytes.slice();
  copy[index] = copy[index]! ^ (1 << bit);
  return copy;
}
