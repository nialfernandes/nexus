// What a device may send, checked once, in one place. Each check answers with a refusal in plain words. Nothing a
// caller sent is repeated in a refusal: a message names what was expected, never what arrived.

import { base64Length, decodeBase64 } from "./bytes";
import { Refusal } from "./refusal";

/** A note's encrypted blob is kept up to this many bytes: well inside the 2 MB a database row can hold once it is written as base64. */
export const MAX_BLOB_BYTES = 1_000_000;

/** A key wrap (a Recovery wrap is 74 bytes, a password wrap 102) is kept up to this many bytes. */
export const MAX_WRAP_BYTES = 1024;

/** The largest key number: the 4-byte `kid` of docs/FORMAT.md. */
export const MAX_KID = 4_294_967_295;

/** The longest note id. */
export const MAX_ID_LENGTH = 128;

/**
 * A note id is chosen by the device, at random, and says nothing about the note. Letters, digits, `_` and `-` are
 * what url-safe base64, hex and a UUID are written in. A `/` or a `.` is left out on purpose: a path has them, and
 * a path must never be used as an id.
 */
const NOTE_ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);

/** The fields a body may hold. Any other is refused, so an old client that still sends a path and a text is told so and not quietly half obeyed. */
export function onlyFields(input: Record<string, unknown>, allowed: readonly string[], what: string): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Refusal(400, `${what} holds only these fields: ${allowed.join(", ")}.`);
  }
}

export function noteId(value: unknown): string {
  if (typeof value !== "string" || !NOTE_ID.test(value)) {
    throw new Refusal(400, `A note id is 1 to ${MAX_ID_LENGTH} letters, digits, hyphens or underscores, chosen at random by the device. It is never a path.`);
  }
  return value;
}

/** A whole number from `min` up, in a body or a query. `what` names it in the refusal. */
export function wholeNumber(value: unknown, what: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Refusal(400, `The ${what} has to be a whole number, ${min} or more.`);
  }
  return value;
}

/** A version the caller asks for, or undefined when none was asked for. */
export function optionalVersion(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : wholeNumber(value, "version", 1);
}

/** The number of a vault key. */
export function kidOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_KID) {
    throw new Refusal(400, `The kid has to be a whole number from 0 to ${MAX_KID}: the number of the vault key the data is under.`);
  }
  return value;
}

export interface Bytes {
  /** The base64 text as it came, which is also how it is kept and sent back. */
  text: string;
  bytes: Uint8Array;
}

/** An encrypted blob or a wrap, sent as base64: checked for what it is and how long it is, and never looked into. */
export function bytesOf(value: unknown, what: string, maxBytes: number): Bytes {
  if (typeof value !== "string" || value === "") {
    throw new Refusal(400, `A ${what} is needed, as base64 text.`);
  }
  // Too long is told before anything is decoded, so a huge text costs nothing.
  if (value.length > base64Length(maxBytes)) {
    throw new Refusal(413, `That ${what} is too long to keep (the limit is ${maxBytes} bytes).`);
  }
  const bytes = decodeBase64(value);
  if (bytes === null) throw new Refusal(400, `The ${what} has to be standard base64 with its = padding.`);
  if (bytes.length > maxBytes) throw new Refusal(413, `That ${what} is too long to keep (the limit is ${maxBytes} bytes).`);
  return { text: value, bytes };
}
