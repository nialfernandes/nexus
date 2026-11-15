// The note store: every save is a version, nothing is ever changed or removed, and a save that did not start from the
// note's latest version is refused.
//
// WHAT IS KEPT. The server holds encrypted blobs and nothing else about a note (docs/FORMAT.md). A NOTE is a row with
// an id the device chose (random, or made from a key the device keeps; never the path) and the number of its latest version. A VERSION is a row that is
// written once: the note's id, its number, the number of the vault key it is under (`kid`), the encrypted blob as
// base64, SHA-256 of the blob, the writer and the time. The server cannot read a note, so it keeps no path, no name,
// no folder and no text, cannot search, and cannot merge two edits: the device does that (packages/merge).
//
// HOW TWO SAVES AT ONE MOMENT STAY SAFE. A save names the version it started from, `base` (0 for a note that is new).
// If the note is at another version the save is refused with the version it is at, and the device reads the note,
// merges, and saves again. D1 has no open transactions, only a `batch` that is applied whole or not at all. Every write
// is one batch that adds version `base + 1` of its note. The pair (note, version) is the table's key, so if someone
// else added that version first the batch fails whole and nothing of it is kept. The loser reads the note again and
// decides again, and now finds the note has moved on, which is a refusal. Version numbers stay without gaps because a
// number is only ever taken by the batch that finds it free.
//
// WHO MAY DO WHAT. Any caller may save, read and delete (caller.ts: there are no folder rights). The writer kept on a
// version is the caller's writer: the device that made the call (caller.ts).
//
// Everything here talks to a SqlDb, a Clock and Secrets and nothing else (ports.ts).

import { noteId, bytesOf, kidOf, MAX_BLOB_BYTES, onlyFields, optionalVersion, wholeNumber } from "./fields";
import { blobHash } from "./hash";
import { checkNoteBlob } from "./header";
import type { NexusHost, SqlDb, SqlStatement } from "./ports";
import { stmt } from "./ports";
import { Refusal } from "./refusal";
import type { Caller } from "./caller";

export type VersionKind = "save" | "delete";

export interface NoteRow {
  id: string;
  deleted: number;
  version: number;
  updated_at: number;
}

export interface VersionRow {
  note_id: string;
  version: number;
  seq: number;
  kind: VersionKind;
  kid: number;
  blob: string;
  hash: string;
  writer: string;
  saved_at: number;
}

/** How many times a write runs again after another writer got in first. A real fault still ends the loop. */
const MAX_TRIES = 8;

export type SaveAnswer = { result: "saved"; id: string; version: number };
export type DeleteAnswer = { result: "deleted"; id: string; version: number };

export interface SaveInput {
  id?: unknown;
  base?: unknown;
  kid?: unknown;
  blob?: unknown;
}

/** The fields of a save and of a delete, for the refusal of any other. */
const SAVE_FIELDS = ["id", "base", "kid", "blob"] as const;
const DELETE_FIELDS = ["id", "base"] as const;

// ── finding things ───────────────────────────────────────────────────────────

async function noteById(sql: SqlDb, id: string): Promise<NoteRow | null> {
  return sql.first<NoteRow>("SELECT * FROM nexus_notes WHERE id = ?", [id]);
}

async function versionOf(sql: SqlDb, id: string, version: number): Promise<VersionRow | null> {
  return sql.first<VersionRow>("SELECT * FROM nexus_versions WHERE note_id = ? AND version = ?", [id, version]);
}

const noNote = () => new Refusal(404, "There is no note with that id.");

/** The refusal of a save or a delete that started from a version the note is no longer at. `current` is 0 when there is no such note. */
const movedOn = (current: number, base: number) =>
  new Refusal(409, `The note is at version ${current}, not ${base}. Read it, merge your edit into it, and save again from version ${current}.`, { current });

// ── writing ──────────────────────────────────────────────────────────────────

/** Every version-writing statement, one place: the next global number is taken in the same statement. */
function insertVersion(v: {
  id: string; version: number; kind: VersionKind; kid: number; blob: string; hash: string; writer: string; at: number;
}): SqlStatement {
  return stmt(
    `INSERT INTO nexus_versions (note_id, version, seq, kind, kid, blob, hash, writer, saved_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM nexus_versions), ?, ?, ?, ?, ?, ?)`,
    v.id, v.version, v.kind, v.kid, v.blob, v.hash, v.writer, v.at,
  );
}

/**
 * Runs a write as one batch. False means another writer got in first (or the batch failed) and nothing was kept;
 * the caller reads again and decides again. The last failure is thrown after MAX_TRIES so a real fault is not hidden.
 */
async function commit(sql: SqlDb, statements: SqlStatement[], attempt: number): Promise<boolean> {
  try {
    await sql.batch(statements);
    return true;
  } catch (error) {
    if (attempt + 1 >= MAX_TRIES) throw error;
    return false;
  }
}

/** Runs `once` until it commits. `once` answers undefined when its write lost to another writer. */
async function untilCommitted<T>(once: (attempt: number) => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const answer = await once(attempt);
    if (answer !== undefined) return answer;
  }
  throw new Error("Nexus could not finish a write: other writes kept getting in first.");
}

export async function save(host: NexusHost, caller: Caller, input: SaveInput): Promise<SaveAnswer> {
  onlyFields(input as Record<string, unknown>, SAVE_FIELDS, "A save");
  const id = noteId(input.id);
  const base = wholeNumber(input.base, "base", 0);
  const kid = kidOf(input.kid);
  const { text: blob, bytes } = bytesOf(input.blob, "blob", MAX_BLOB_BYTES);
  checkNoteBlob(bytes, kid);
  const hash = await blobHash(host.secrets, bytes);
  const writer = caller.writer;
  const { sql } = host;

  return untilCommitted(async (attempt): Promise<SaveAnswer | undefined> => {
    const now = host.clock.now();
    const note = await noteById(sql, id);
    const current = note?.version ?? 0;
    if (base !== current) throw movedOn(current, base);

    const next = current + 1;
    const done = await commit(sql, [
      // A new note is its row and its first version in one batch, the row first because the version points at it. An
      // old one, a deleted one brought back included, moves its row on to the new version.
      note === null
        ? stmt("INSERT INTO nexus_notes (id, deleted, version, updated_at) VALUES (?, 0, 1, ?)", id, now)
        : stmt("UPDATE nexus_notes SET deleted = 0, version = ?, updated_at = ? WHERE id = ?", next, now, id),
      insertVersion({ id, version: next, kind: "save", kid, blob, hash, writer, at: now }),
    ], attempt);
    return done ? { result: "saved", id, version: next } : undefined;
  });
}

export async function remove(host: NexusHost, caller: Caller, input: { id?: unknown; base?: unknown }): Promise<DeleteAnswer> {
  onlyFields(input as Record<string, unknown>, DELETE_FIELDS, "A delete");
  const id = noteId(input.id);
  const base = wholeNumber(input.base, "base", 0);
  const writer = caller.writer;
  const { sql } = host;

  return untilCommitted(async (attempt): Promise<DeleteAnswer | undefined> => {
    const now = host.clock.now();
    const note = await noteById(sql, id);
    if (!note || note.deleted) throw noNote();
    if (base !== note.version) throw movedOn(note.version, base);

    // The delete version keeps the blob it followed, as it always kept the text, so the history still reads.
    const head = await versionOf(sql, id, note.version);
    if (!head) throw new Error(`Nexus note ${note.id} has no version ${note.version}`);
    const next = note.version + 1;
    const done = await commit(sql, [
      insertVersion({ id, version: next, kind: "delete", kid: head.kid, blob: head.blob, hash: head.hash, writer, at: now }),
      stmt("UPDATE nexus_notes SET deleted = 1, version = ?, updated_at = ? WHERE id = ?", next, now, id),
    ], attempt);
    return done ? { result: "deleted", id, version: next } : undefined;
  });
}

// ── reading ──────────────────────────────────────────────────────────────────

/** One note: its latest version, or the one asked for (which a deleted note still gives). */
export async function readNote(host: NexusHost, _caller: Caller, idInput: unknown, versionInput?: unknown): Promise<VersionRow> {
  const id = noteId(idInput);
  const asked = optionalVersion(versionInput);
  const note = await noteById(host.sql, id);
  if (!note) throw noNote();
  if (asked === undefined && note.deleted) throw new Refusal(404, "That note was deleted. Its history can still be read.");
  const version = await versionOf(host.sql, id, asked ?? note.version);
  if (!version) throw new Refusal(404, "That note has no such version.");
  return version;
}

/** A note's versions, oldest first, deleted notes included. The blobs are left out: read a version for its blob. */
export async function readHistory(host: NexusHost, _caller: Caller, idInput: unknown): Promise<{ id: string; versions: VersionRow[] }> {
  const id = noteId(idInput);
  if (!(await noteById(host.sql, id))) throw noNote();
  const versions = await host.sql.all<VersionRow>("SELECT * FROM nexus_versions WHERE note_id = ? ORDER BY version", [id]);
  return { id, versions };
}

export interface ListedNote {
  id: string;
  version: number;
  at: number;
  kid: number;
  hash: string;
}

/** The live notes, by id: the latest version of each, its time, its key number and its fingerprint. */
export async function list(host: NexusHost, _caller: Caller): Promise<ListedNote[]> {
  return host.sql.all<ListedNote>(
    `SELECT n.id AS id, n.version AS version, n.updated_at AS at, v.kid AS kid, v.hash AS hash
       FROM nexus_notes n JOIN nexus_versions v ON v.note_id = n.id AND v.version = n.version
      WHERE n.deleted = 0 ORDER BY n.id`,
  );
}

export const DEFAULT_CHANGES = 100;
export const MAX_CHANGES = 500;

/**
 * How much blob text one page of the changes feed may send, when the person who runs Nexus has not chosen (the
 * setting `changesPageBytes`, ports.ts). A version carries its whole blob, up to 1,000,000 bytes and 1,333,336
 * characters of base64, so 500 of them would be most of a gigabyte. 4,000,000 is two of the largest notes, or many
 * small ones, in a page a phone can take.
 */
export const DEFAULT_CHANGES_PAGE_BYTES = 4_000_000;

/** The cursor and the page size of a call to the changes feed or the heads listing, checked. */
function askedPage(afterInput: unknown, limitInput: unknown): { after: number; limit: number } {
  let after = 0;
  if (afterInput !== undefined && afterInput !== null && afterInput !== "") {
    if (typeof afterInput !== "string" && typeof afterInput !== "number") throw new Refusal(400, "The cursor has to be the one a previous answer gave.");
    const text = String(afterInput);
    if (!/^\d{1,15}$/.test(text)) throw new Refusal(400, "The cursor has to be the one a previous answer gave.");
    after = Number(text);
  }
  let limit = DEFAULT_CHANGES;
  if (limitInput !== undefined && limitInput !== null && limitInput !== "") {
    limit = Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1) throw new Refusal(400, "The limit has to be a whole number of changes, 1 or more.");
    limit = Math.min(limit, MAX_CHANGES);
  }
  return { after, limit };
}

/** How many of the versions, in order, fit one page: a page holds at least one, and ends before the version that would take its blobs past `cap`. */
function fitsPage(sizes: Array<{ size: number }>, cap: number): number {
  let count = 0;
  let bytes = 0;
  for (const { size } of sizes) {
    if (count > 0 && bytes + size > cap) break;
    bytes += size;
    count += 1;
  }
  return count;
}

/**
 * Every version after a cursor, oldest first, and the cursor to carry on from. A cursor is the place of the last
 * version sent. With nothing new the same cursor comes back, so asking again is always safe.
 *
 * A page ends at `limit` versions or just before the version that would take the blobs it sends past
 * `changesPageBytes`, whichever is first, so a version is never cut in two and the next page starts at the next
 * version. A page holds at least one version: one larger than the cap goes alone, or the cursor could never move on.
 * What is counted is the blob as sent (base64 text); a delete is sent with no blob and counts for none.
 *
 * The sizes are read first, without the blobs, so a page that is cut short never reads the blobs it leaves for the next.
 */
export async function changes(host: NexusHost, _caller: Caller, afterInput: unknown, limitInput: unknown): Promise<{ rows: VersionRow[]; next: string }> {
  const { after, limit } = askedPage(afterInput, limitInput);
  const sizes = await host.sql.all<{ seq: number; size: number }>(
    "SELECT seq, CASE WHEN kind = 'save' THEN LENGTH(blob) ELSE 0 END AS size FROM nexus_versions WHERE seq > ? ORDER BY seq LIMIT ?",
    [after, limit],
  );
  const count = fitsPage(sizes, host.settings.changesPageBytes);
  if (count === 0) return { rows: [], next: String(after) };

  const last = sizes[count - 1].seq;
  const rows = await host.sql.all<VersionRow>("SELECT * FROM nexus_versions WHERE seq > ? AND seq <= ? ORDER BY seq", [after, last]);
  return { rows, next: String(last) };
}

/**
 * The newest version of every note, deleted notes included (as a delete, with no blob), and the cursor to carry on from.
 * It is for a client that wants to know what the vault holds now and does not need the versions that were replaced: it
 * sends one blob per note where the changes feed sends one per version.
 *
 * It pages as the changes feed does, with the same limit and the same cap on the blobs of a page, and its cursor is the
 * `seq` of the last newest version sent. Notes come in the order of their newest version, so a note saved again while a
 * client is reading the pages moves to the end and is met once more, at its new version: no note is missed, and a
 * client keeps the highest version it was given for each. The newest version of any note is the version with the
 * highest `seq` at the moment, so when a page comes back empty the cursor is the place of the very last version Nexus
 * holds, and the changes feed asked from it gives exactly what happened after the listing.
 */
export async function heads(host: NexusHost, _caller: Caller, afterInput: unknown, limitInput: unknown): Promise<{ rows: VersionRow[]; next: string }> {
  const { after, limit } = askedPage(afterInput, limitInput);
  const sizes = await host.sql.all<{ seq: number; size: number }>(
    `SELECT v.seq AS seq, CASE WHEN v.kind = 'save' THEN LENGTH(v.blob) ELSE 0 END AS size
       FROM nexus_versions v JOIN nexus_notes n ON n.id = v.note_id AND n.version = v.version
      WHERE v.seq > ? ORDER BY v.seq LIMIT ?`,
    [after, limit],
  );
  const count = fitsPage(sizes, host.settings.changesPageBytes);
  if (count === 0) return { rows: [], next: String(after) };

  const last = sizes[count - 1].seq;
  const rows = await host.sql.all<VersionRow>(
    `SELECT v.* FROM nexus_versions v JOIN nexus_notes n ON n.id = v.note_id AND n.version = v.version
      WHERE v.seq > ? AND v.seq <= ? ORDER BY v.seq`,
    [after, last],
  );
  return { rows, next: String(last) };
}
