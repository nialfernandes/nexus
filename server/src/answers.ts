// What Nexus says, in one place: the wire shape of every answer. A row of the database is never sent as it is; it
// is turned into one of these, so the columns can change without the callers noticing. `at` is unix milliseconds,
// `merged` and `clash` are true or false, `writer` is the name of the identity that wrote the version.

import type { ListedNote, NoteRead, VersionRow } from "./store";

export interface NoteAnswer {
  path: string;
  version: number;
  text: string;
  writer: string;
  at: number;
  hash: string;
  /** The note is flagged: a clash version waits beside it. */
  clash: boolean;
  kind: string;
  merged: boolean;
  /** This very version is a clash version (the text of a save that could not be merged). */
  clashVersion: boolean;
}

export const noteAnswer = (read: NoteRead): NoteAnswer => ({
  path: read.path,
  version: read.version.version,
  text: read.version.body,
  writer: read.version.writer,
  at: read.version.saved_at,
  hash: read.version.hash,
  clash: read.flagged,
  kind: read.version.kind,
  merged: read.version.merged === 1,
  clashVersion: read.version.clash === 1,
});

/** One line of a note's history. `clash` here says that version is a clash version. */
export const historyEntry = (v: VersionRow) => ({
  version: v.version,
  kind: v.kind,
  writer: v.writer,
  at: v.saved_at,
  hash: v.hash,
  merged: v.merged === 1,
  clash: v.clash === 1,
  ...(v.from_path === null ? {} : { from: v.from_path }),
  ...(v.resolves === null ? {} : { resolves: v.resolves }),
});

export const listEntry = (n: ListedNote) => ({ path: n.path, version: n.version, at: n.at, clash: n.clash });

/** One version in the changes feed. A save carries its whole text; a move or a delete carries none. */
export const changeEntry = (v: VersionRow) => ({
  path: v.path,
  version: v.version,
  kind: v.kind,
  writer: v.writer,
  at: v.saved_at,
  hash: v.hash,
  merged: v.merged === 1,
  clash: v.clash === 1,
  ...(v.kind === "save" ? { text: v.body } : {}),
  ...(v.from_path === null ? {} : { from: v.from_path }),
  ...(v.resolves === null ? {} : { resolves: v.resolves }),
});
