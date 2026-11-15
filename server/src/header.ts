// The one check the server makes on what a device says is encrypted: that the bytes begin the way an encrypted note
// or wrap begins (docs/FORMAT.md sections 6 and 7). It exists so a device that forgot to encrypt cannot leave its notes
// in plain text here without anyone noticing.
//
// It reads the length and the first five bytes at most, and nothing after them: the server never opens a note, and a
// check that looked further would be a step toward doing so. A blob whose header is right and whose rest is random
// passes, on purpose. This is not proof that a blob is encrypted, only that it is not obviously plain text.
//
// A refusal is a 400 with a `reason`, a name a device can act on, beside the plain words in `error`.

import { FORMAT_VERSION, Kind, MIN_WRITTEN_NOTE_BLOB_BYTES, PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES } from "@nexus/crypto/format";
import { Refusal } from "./refusal";
import type { WrapKind } from "./wraps";

// Every number below is the format's, and @nexus/crypto owns it: the server takes it from `@nexus/crypto/format`, a file of
// numbers that holds no encryption, so a change to the format moves the server's check with it.

/** A new note blob is at least this long: the header, the record padded to its floor, and the tag (docs/FORMAT.md section 6). */
export const MIN_NOTE_BLOB_BYTES = MIN_WRITTEN_NOTE_BLOB_BYTES;

/** What a wrap begins with, and how long it is: the second byte says which wrap it is (docs/FORMAT.md section 7). */
export const WRAP_HEADERS: Readonly<Record<WrapKind, { kindByte: number; bytes: number }>> = {
  recovery: { kindByte: Kind.recoveryWrap, bytes: RECOVERY_WRAP_BYTES },
  password: { kindByte: Kind.passwordWrap, bytes: PASSWORD_WRAP_BYTES },
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
