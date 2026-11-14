import { MAX_ID_BYTES, MAX_KID } from "./constants.js";
import { NexusCryptoError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Reads UTF-8 and refuses invalid sequences instead of replacing them. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new NexusCryptoError("malformed", "text is not valid UTF-8");
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** An unsigned 32-bit number, most significant byte first. */
export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

/** A string as its UTF-8 byte length (4 bytes) followed by the bytes, so joined fields cannot blur. */
export function lengthPrefixed(text: string): Uint8Array {
  const bytes = utf8(text);
  return concatBytes(u32be(bytes.length), bytes);
}

export function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new NexusCryptoError("invalid-argument", `${name} must be a Uint8Array of ${length} bytes`);
  }
  return value;
}

/** True when the string holds half of a surrogate pair, which UTF-8 cannot carry. */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function requireId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasLoneSurrogate(value) ||
    utf8(value).length > MAX_ID_BYTES
  ) {
    throw new NexusCryptoError("invalid-argument", `${name} must be a non-empty, well-formed string of at most ${MAX_ID_BYTES} UTF-8 bytes`);
  }
  return value;
}

export function requireKid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_KID) {
    throw new NexusCryptoError("invalid-argument", `kid must be an integer from 0 to ${MAX_KID}`);
  }
  return value;
}
