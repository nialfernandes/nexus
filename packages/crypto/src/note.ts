import { aeadOpen, aeadSeal } from "./aead.js";
import { noteAssociatedData, type NoteContext } from "./associated-data.js";
import { fromUtf8, requireBytes, utf8 } from "./bytes.js";
import { FORMAT_VERSION, Kind, KEY_BYTES, MAX_RECORD_BYTES, NONCE_BYTES, TAG_BYTES } from "./constants.js";
import { NexusCryptoError } from "./errors.js";
import { padRecord, unpadRecord } from "./padme.js";
import { loadSodium, type Sodium } from "./sodium.js";

/** What a note holds before encryption: where it lives in the vault, and its text. */
export interface NoteRecord {
  path: string;
  text: string;
}

/** The shortest possible blob: version, nonce, the tag, and one byte (the end mark). */
export const MIN_NOTE_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES + 1;

/** A new vault key: 256 random bits. */
export async function generateVaultKey(): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sodium.randombytes_buf(KEY_BYTES);
}

/**
 * Encrypts one note. The blob is: version (1 byte), nonce (24), then the
 * ciphertext and tag. See docs/FORMAT.md.
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
 * encrypted with.
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
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const sealed = blob.subarray(1 + NONCE_BYTES);
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
    const blob = new Uint8Array(1 + NONCE_BYTES + sealed.length);
    blob[0] = FORMAT_VERSION;
    blob.set(nonce, 1);
    blob.set(sealed, 1 + NONCE_BYTES);
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
