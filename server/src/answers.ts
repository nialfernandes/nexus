// What Nexus says, in one place: the wire shape of every answer. A row of the database is never sent as it is; it
// is turned into one of these, so the columns can change without the callers noticing. `at` is unix milliseconds,
// `writer` is the name of the identity that wrote the version, `blob` and `wrap` are base64 of bytes the server cannot
// read, and `hash` is SHA-256 of the blob (hash.ts).

import type { ListedNote, VersionRow } from "./store";
import type { WrapRow } from "./wraps";

/** One version of a note, with its blob. A delete version carries the blob it followed. */
export const noteAnswer = (v: VersionRow) => ({
  id: v.note_id,
  version: v.version,
  kind: v.kind,
  kid: v.kid,
  blob: v.blob,
  hash: v.hash,
  writer: v.writer,
  at: v.saved_at,
});

/** One line of a note's history: no blob. */
export const historyEntry = (v: VersionRow) => ({
  version: v.version,
  kind: v.kind,
  kid: v.kid,
  writer: v.writer,
  at: v.saved_at,
  hash: v.hash,
});

export const listEntry = (n: ListedNote) => ({ id: n.id, version: n.version, at: n.at, kid: n.kid, hash: n.hash });

/** One version in the changes feed. A save carries its blob; a delete carries none. */
export const changeEntry = (v: VersionRow) => ({
  id: v.note_id,
  version: v.version,
  kind: v.kind,
  kid: v.kid,
  writer: v.writer,
  at: v.saved_at,
  hash: v.hash,
  ...(v.kind === "save" ? { blob: v.blob } : {}),
});

export const wrapEntry = (w: WrapRow) => ({ kid: w.kid, kind: w.kind, wrap: w.wrap, writer: w.writer, at: w.saved_at });
