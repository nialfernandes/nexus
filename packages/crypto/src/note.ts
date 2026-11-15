import { aeadOpen, aeadSeal } from "./aead.js";
import { noteAssociatedData, type NoteContext } from "./associated-data.js";
import { fromUtf8, readU32be, requireBytes, u32be, utf8 } from "./bytes.js";
import { FORMAT_VERSION, Kind, KEY_BYTES, KID_BYTES, MAX_RECORD_BYTES, NONCE_BYTES, TAG_BYTES } from "./constants.js";
import { NexusCryptoError } from "./errors.js";
import { NOTE_HEADER_BYTES } from "./format.js";
import { padRecord, unpadRecord } from "./padme.js";
import { loadSodium, type Sodium } from "./sodium.js";

/** What a note holds before encryption: where it lives in the vault, and its text. */
export interface NoteRecord {
  path: string;
  text: string;
}

/** Where each part of a note blob starts: version (1), kid (4), nonce (24), then the ciphertext. */
const KID_OFFSET = 1;
const NONCE_OFFSET = KID_OFFSET + KID_BYTES;
const SEALED_OFFSET = NOTE_HEADER_BYTES;

/** The shortest possible blob: the header, the tag, and one byte (the end mark). */
export const MIN_NOTE_BLOB_BYTES = SEALED_OFFSET + TAG_BYTES + 1;

/** A new vault key: 256 random bits. */
export async function generateVaultKey(): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sodium.randombytes_buf(KEY_BYTES);
}

/**
 * Encrypts one note. The blob is: version (1 byte), kid (4), nonce (24), then
 * the ciphertext and tag. See docs/FORMAT.md.
 */
export async function encryptNote(
  vaultKey: Uint8Array,
  context: NoteContext,
  record: NoteRecord,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sealNote(sodium, vaultKey, context, record, sodium.randombytes_buf(NONCE_BYTES));
}

/**
 * Decrypts one note, or throws a NexusCryptoError and returns nothing.
 * The key, vault id, note id and kid must all be the ones the note was
 * encrypted with. A blob that names another kid than the context's is refused
 * as "wrong-kid" before any decryption is tried.
 */
export async function decryptNote(
  vaultKey: Uint8Array,
  context: NoteContext,
  blob: Uint8Array,
): Promise<NoteRecord> {
  const sodium = await loadSodium();
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  const associatedData = noteAssociatedData(Kind.note, context);
  if (!(blob instanceof Uint8Array)) {
    throw new NexusCryptoError("invalid-argument", "blob must be a Uint8Array");
  }
  if (blob.length < MIN_NOTE_BLOB_BYTES) {
    throw new NexusCryptoError("truncated", "blob is shorter than the smallest valid note blob");
  }
  if (blob[0] !== FORMAT_VERSION) {
    throw new NexusCryptoError("unsupported-version", `note blob has format version ${blob[0]}`);
  }
  const blobKid = readU32be(blob, KID_OFFSET);
  if (blobKid !== context.kid) {
    throw new NexusCryptoError("wrong-kid", `note blob is under kid ${blobKid}, not kid ${context.kid}`);
  }
  const nonce = blob.subarray(NONCE_OFFSET, SEALED_OFFSET);
  const sealed = blob.subarray(SEALED_OFFSET);
  const padded = aeadOpen(sodium, vaultKey, nonce, associatedData, sealed, "decryption-failed");
  try {
    return parseRecord(unpadRecord(padded));
  } finally {
    sodium.memzero(padded);
  }
}

/**
 * The encryption with the nonce passed in. Not exported from the package: a
 * nonce must be random and used once, and only tests need to fix it.
 */
export function sealNote(
  sodium: Sodium,
  vaultKey: Uint8Array,
  context: NoteContext,
  record: NoteRecord,
  nonce: Uint8Array,
): Uint8Array {
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  const associatedData = noteAssociatedData(Kind.note, context);
  const padded = padRecord(serializeRecord(record));
  try {
    const sealed = aeadSeal(sodium, vaultKey, nonce, associatedData, padded);
    const blob = new Uint8Array(SEALED_OFFSET + sealed.length);
    blob[0] = FORMAT_VERSION;
    blob.set(u32be(context.kid), KID_OFFSET);
    blob.set(nonce, NONCE_OFFSET);
    blob.set(sealed, SEALED_OFFSET);
    return blob;
  } finally {
    sodium.memzero(padded);
  }
}

function serializeRecord(record: NoteRecord): Uint8Array {
  if (typeof record?.path !== "string" || typeof record?.text !== "string") {
    throw new NexusCryptoError("invalid-argument", "record must have a string path and a string text");
  }
  const bytes = utf8(JSON.stringify({ path: record.path, text: record.text }));
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new NexusCryptoError("invalid-argument", "record is too large");
  }
  return bytes;
}

function parseRecord(bytes: Uint8Array): NoteRecord {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(bytes));
  } catch (error) {
    if (error instanceof NexusCryptoError) throw error;
    throw new NexusCryptoError("malformed", "decrypted record is not valid JSON");
  }
  const fields = value as { path?: unknown; text?: unknown } | null;
  if (typeof fields?.path !== "string" || typeof fields?.text !== "string") {
    throw new NexusCryptoError("malformed", "decrypted record has no string path and text");
  }
  return { path: fields.path, text: fields.text };
}
