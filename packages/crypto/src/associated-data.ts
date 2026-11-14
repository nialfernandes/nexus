import { concatBytes, lengthPrefixed, requireId, requireKid, u32be } from "./bytes.js";
import { FORMAT_VERSION, type Kind } from "./constants.js";

export type KindValue = (typeof Kind)[keyof typeof Kind];

/** Names the vault, and the key number the data is under. */
export interface VaultContext {
  vaultId: string;
  kid: number;
}

/** Names a single note as well: what a note blob is bound to. */
export interface NoteContext extends VaultContext {
  noteId: string;
}

/**
 * The associated data: format version, kind, kid, vault id, subject.
 * The subject is the note id for a note and empty for a wrap. Each id carries
 * its length, so "ab" + "c" and "a" + "bc" cannot give the same bytes.
 */
export function buildAssociatedData(kind: KindValue, context: VaultContext, subject: string): Uint8Array {
  const vaultId = requireId(context.vaultId, "vaultId");
  const kid = requireKid(context.kid);
  return concatBytes(
    Uint8Array.of(FORMAT_VERSION, kind),
    u32be(kid),
    lengthPrefixed(vaultId),
    lengthPrefixed(subject),
  );
}

export function noteAssociatedData(kind: KindValue, context: NoteContext): Uint8Array {
  return buildAssociatedData(kind, context, requireId(context.noteId, "noteId"));
}
