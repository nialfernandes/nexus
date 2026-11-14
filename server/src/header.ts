// The one check the server makes on what a device says is encrypted: that the bytes begin the way an encrypted note
// or wrap begins (docs/FORMAT.md sections 6 and 7). It exists so a device that forgot to encrypt cannot leave its notes
// in plain text here without anyone noticing.
//
// It reads the length and the first five bytes at most, and nothing after them: the server never opens a note, and a
// check that looked further would be a step toward doing so. A blob whose header is right and whose rest is random
// passes, on purpose. This is not proof that a blob is encrypted, only that it is not obviously plain text.
//
// A refusal is a 400 with a `reason`, a name a device can act on, beside the plain words in `error`.

import { Refusal } from "./refusal";
import type { WrapKind } from "./wraps";

/** The format version in the first byte of every note blob and wrap (docs/FORMAT.md section 2). */
export const FORMAT_VERSION = 1;

/** The bytes of a note blob before its ciphertext: version (1), kid (4) and nonce (24). */
const NOTE_HEADER_BYTES = 1 + 4 + 24;

/** A new note blob is at least this long: the header, the record padded to 256 bytes, and the 16-byte tag (docs/FORMAT.md section 6). */
export const MIN_NOTE_BLOB_BYTES = NOTE_HEADER_BYTES + 256 + 16;

/** What a wrap begins with, and how long it is: the second byte says which wrap it is (docs/FORMAT.md section 7). */
export const WRAP_HEADERS: Readonly<Record<WrapKind, { kindByte: number; bytes: number }>> = {
  recovery: { kindByte: 0x02, bytes: 74 },
  password: { kindByte: 0x03, bytes: 102 },
};

/** The names a refusal carries in `reason`. */
export type HeaderReason =
  | "not-an-encrypted-blob"
  | "blob-too-short"
  | "kid-mismatch"
  | "not-an-encrypted-wrap"
  | "wrap-too-short"
  | "kind-mismatch";

const refuse = (reason: HeaderReason, words: string): Refusal => new Refusal(400, words, { reason });

/** The kid a note blob names in bytes 1 to 4, written big-endian. Call it only on a blob of five bytes or more. */
const kidInHeader = (bytes: Uint8Array): number => ((bytes[1]! << 24) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!) >>> 0;

/**
 * Refuses a blob that does not begin as an encrypted note does: not the format's version, shorter than the
 * smallest blob, or naming another vault key than the save's `kid`. The version is checked first, so plain text of any
 * length is told it is not encrypted, not that it is short.
 */
export function checkNoteBlob(bytes: Uint8Array, kid: number): void {
  if (bytes[0] !== FORMAT_VERSION) {
    throw refuse("not-an-encrypted-blob", "That blob is not an encrypted note: it does not begin with the encryption format's version byte. Nexus keeps only notes a device has encrypted.");
  }
  if (bytes.length < MIN_NOTE_BLOB_BYTES) {
    throw refuse("blob-too-short", `That blob is too short to be an encrypted note: the smallest is ${MIN_NOTE_BLOB_BYTES} bytes.`);
  }
  if (kidInHeader(bytes) !== kid) {
    throw refuse("kid-mismatch", "The kid in the save is not the kid the blob names in its header, the number of the vault key it is under.");
  }
}

/**
 * The same for a wrap of `kind`: the format's version, then the kind byte that says which wrap it is, then the length.
 * The kind comes before the length so a Recovery wrap sent as a password wrap is told it is the wrong kind, not that it is short.
 */
export function checkWrap(bytes: Uint8Array, kind: WrapKind): void {
  const header = WRAP_HEADERS[kind];
  if (bytes[0] !== FORMAT_VERSION) {
    throw refuse("not-an-encrypted-wrap", "That wrap is not an encrypted key wrap: it does not begin with the encryption format's version byte.");
  }
  if (bytes[1] !== header.kindByte) {
    throw refuse("kind-mismatch", `The wrap's second byte does not say it is a ${kind} wrap.`);
  }
  if (bytes.length < header.bytes) {
    throw refuse("wrap-too-short", `That wrap is too short to be a ${kind} wrap: the smallest is ${header.bytes} bytes.`);
  }
}
