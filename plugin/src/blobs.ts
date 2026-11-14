// The only file in the plugin that encrypts or decrypts a note. Everything that leaves the device as a note is made by
// `sealNote`, and everything that comes from the server as a note is read by `openNote`; the sync engine has no other way to
// get at a note's text or path from the server's side, so nothing can be sent or shown without going through here.
//
// A blob is bound to the vault, the note id and the key number (docs/FORMAT.md section 4), so a blob moved to another note,
// another vault or another key does not open, and neither does one with a single byte changed.

import { NexusCryptoError, decryptNote, encryptNote } from "@nexus/crypto";
import { decodeBase64, encodeBase64 } from "./base64";
import type { VaultKeys } from "./unlock";

/** What a note holds before it is encrypted and after it is opened. */
export interface NoteContent {
  path: string;
  text: string;
}

/**
 * The server's blob for a note could not be opened. It is never shown and never written into the vault. `reason` is
 * the encryption's own word for what was wrong (decryption-failed, wrong-kid, truncated, malformed ...).
 */
export class Unreadable extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`The note ${id} did not open (${reason}).`);
  }
}

const contextOf = (keys: VaultKeys, id: string) => ({ vaultId: keys.vaultId, noteId: id, kid: keys.kid });

/** One note, encrypted and written as the base64 text the server takes. */
export async function sealNote(keys: VaultKeys, id: string, content: NoteContent): Promise<string> {
  return encodeBase64(await encryptNote(keys.vaultKey, contextOf(keys, id), { path: content.path, text: content.text }));
}

/** One note, from the base64 text the server gave. Throws Unreadable when it does not open. */
export async function openNote(keys: VaultKeys, id: string, blob: unknown): Promise<NoteContent> {
  const bytes = typeof blob === "string" ? decodeBase64(blob) : null;
  if (bytes === null) throw new Unreadable(id, "not base64");
  try {
    const { path, text } = await decryptNote(keys.vaultKey, contextOf(keys, id), bytes);
    return { path, text };
  } catch (error) {
    if (error instanceof NexusCryptoError) throw new Unreadable(id, error.code);
    throw error;
  }
}
