// The note store: every save is a version, nothing is ever changed or removed, and two writers who start from the
// same version both keep their edits (merged) or both keep their text (clash).
//
// A NOTE is a row with a stable id and the path it has now. A VERSION is a row that is written once. The note row
// only points at the versions: `head_version` is the latest version that is the note's text (a clash version is
// not), `last_version` is the latest of all, and `clash` says whether a clash version still waits to be resolved.
//
// HOW TWO SAVES AT ONE MOMENT STAY SAFE. D1 has no open transactions, only a `batch` that is applied whole or not
// at all. Every write is one batch that adds version `last_version + 1` of its note. The pair (note, version) is
// the table's key, so if someone else added that version first the batch fails whole and nothing of it is kept.
// The loser reads the note again and runs its save again, now starting from a note that has moved on, which is
// exactly the case the merge rule is for. Version numbers stay without gaps because a number is only ever taken
// by the batch that finds it free.
//
// WHO MAY DO WHAT. Every call is made by a Caller (rights.ts): a read needs read on the path, a save, a delete and a
// move need write on it (a move on both ends), and the refusal, a 403, names the path whether or not a note is there.
// A list, a search and the changes feed leave out what the caller may not read. The writer kept on a version is the
// caller's name.
//
// Everything here talks to a SqlDb and a Clock and nothing else (ports.ts).

import { shortHash } from "./hash";
import { mergeText } from "./merge";
import { isWholeText, vaultPath } from "./paths";
import type { NexusHost, SqlDb, SqlStatement } from "./ports";
import { stmt } from "./ports";
import { Refusal } from "./refusal";
import { mayRead, requireRead, requireWrite, type Caller } from "./rights";

export type VersionKind = "save" | "move" | "delete";

export interface NoteRow {
  id: number;
  path: string;
  deleted: number;
  head_version: number;
  head_at: number;
  last_version: number;
  clash: number;
}

export interface VersionRow {
  note_id: number;
  version: number;
  seq: number;
  path: string;
  from_path: string | null;
  kind: VersionKind;
  body: string;
  writer: string;
  saved_at: number;
  hash: string;
  merged: number;
  clash: number;
  resolves: number | null;
}

/** A note's text is kept up to this many bytes: well inside the 2 MB a database row can hold. */
export const MAX_TEXT_BYTES = 1_000_000;

/** How many times a write runs again after another writer got in first. A real fault still ends the loop. */
const MAX_TRIES = 8;

export type SaveAnswer =
  | { result: "saved" | "merged"; path: string; version: number }
  | { result: "clash"; path: string; latest: { version: number; text: string }; incoming: { version: number; text: string } };

export interface SaveInput {
  path?: unknown;
  text?: unknown;
  base?: unknown;
  resolves?: unknown;
}

// ── finding things ───────────────────────────────────────────────────────────

/** The note at a path: the live one, else the most recent deleted one, else null. */
async function noteAt(sql: SqlDb, path: string): Promise<NoteRow | null> {
  return sql.first<NoteRow>("SELECT * FROM nexus_notes WHERE path = ? ORDER BY deleted ASC, id DESC LIMIT 1", [path]);
}

async function versionOf(sql: SqlDb, noteId: number, version: number): Promise<VersionRow | null> {
  return sql.first<VersionRow>("SELECT * FROM nexus_versions WHERE note_id = ? AND version = ?", [noteId, version]);
}

async function headOf(sql: SqlDb, note: NoteRow): Promise<VersionRow> {
  const head = await versionOf(sql, note.id, note.head_version);
  if (!head) throw new Error(`Nexus note ${note.id} has no version ${note.head_version}`);
  return head;
}

const noNote = (path: string) => new Refusal(404, `There is no note at ${path}.`);

// ── writing ──────────────────────────────────────────────────────────────────

/** Every version-writing statement, one place: the next global number is taken in the same statement. */
function insertVersion(v: {
  noteId: number | null; version: number; path: string; from: string | null; kind: VersionKind; body: string;
  writer: string; at: number; hash: string; merged: boolean; clash: boolean; resolves: number | null;
}): SqlStatement {
  const note = v.noteId === null ? "(SELECT id FROM nexus_notes WHERE path = ? AND deleted = 0)" : "?";
  return stmt(
    `INSERT INTO nexus_versions
       (note_id, version, seq, path, from_path, kind, body, writer, saved_at, hash, merged, clash, resolves)
     VALUES (${note}, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM nexus_versions), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.noteId ?? v.path, v.version, v.path, v.from, v.kind, v.body, v.writer, v.at, v.hash,
    v.merged ? 1 : 0, v.clash ? 1 : 0, v.resolves,
  );
}

/** True while a clash version exists that no later save resolved. */
const CLASH_STILL_OPEN = `(CASE WHEN EXISTS (
    SELECT 1 FROM nexus_versions c
     WHERE c.note_id = nexus_notes.id AND c.clash = 1
       AND NOT EXISTS (SELECT 1 FROM nexus_versions r WHERE r.note_id = c.note_id AND r.resolves = c.version)
  ) THEN 1 ELSE 0 END)`;

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

function wholeNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Refusal(400, `The ${what} has to be a whole number, a version of the note.`);
  }
  return value;
}

export async function save(host: NexusHost, caller: Caller, input: SaveInput): Promise<SaveAnswer> {
  const path = vaultPath(input.path);
  requireWrite(caller, path);
  const writer = caller.name;
  if (typeof input.text !== "string") throw new Refusal(400, "A save needs the note's text (it can be empty).");
  const text = input.text;
  if (!isWholeText(text)) throw new Refusal(400, "The text holds a character that cannot be kept as UTF-8.");
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw new Refusal(413, `That note is too long to keep (the limit is ${MAX_TEXT_BYTES} bytes).`);
  }
  const base = wholeNumber(input.base, "base");
  const resolves = wholeNumber(input.resolves, "resolves");
  const hash = shortHash(text);
  const { sql } = host;

  return untilCommitted(async (attempt): Promise<SaveAnswer | undefined> => {
    const now = host.clock.now();
    const note = await noteAt(sql, path);

    // A note that is not there yet.
    if (!note) {
      if (base !== undefined) throw new Refusal(404, `There is no note at ${path} to start from. Save it without a base to make it.`);
      if (resolves !== undefined) throw new Refusal(400, "There is no clash to resolve: the note is new.");
      const made = await commit(sql, [
        stmt(
          `INSERT INTO nexus_notes (id, path, deleted, head_version, head_at, last_version, clash)
           VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM nexus_notes), ?, 0, 1, ?, 1, 0)`,
          path, now,
        ),
        insertVersion({ noteId: null, version: 1, path, from: null, kind: "save", body: text, writer, at: now, hash, merged: false, clash: false, resolves: null }),
      ], attempt);
      return made ? { result: "saved", path, version: 1 } : undefined;
    }

    const next = note.last_version + 1;
    const head = await headOf(sql, note);

    if (resolves !== undefined) {
      if (base !== note.head_version) {
        throw new Refusal(400, `A save that resolves a clash has to name the latest version (${note.head_version}) as its base.`);
      }
      const clashed = await versionOf(sql, note.id, resolves);
      const already = await sql.first<{ n: number }>(
        "SELECT 1 AS n FROM nexus_versions WHERE note_id = ? AND resolves = ?", [note.id, resolves]);
      if (!clashed || !clashed.clash) throw new Refusal(400, `Version ${resolves} is not a clash version of this note.`);
      if (already) throw new Refusal(400, `The clash in version ${resolves} was already resolved.`);
    }

    const keep = async (body: string, wasMerged: boolean): Promise<SaveAnswer | undefined> => {
      const done = await commit(sql, [
        insertVersion({ noteId: note.id, version: next, path: note.path, from: null, kind: "save", body, writer, at: now, hash: shortHash(body), merged: wasMerged, clash: false, resolves: resolves ?? null }),
        stmt(
          `UPDATE nexus_notes SET deleted = 0, head_version = ?, head_at = ?, last_version = ?, clash = ${CLASH_STILL_OPEN} WHERE id = ?`,
          next, now, next, note.id,
        ),
      ], attempt);
      return done ? { result: wasMerged ? "merged" : "saved", path, version: next } : undefined;
    };

    const keepAsClash = async (): Promise<SaveAnswer | undefined> => {
      const done = await commit(sql, [
        insertVersion({ noteId: note.id, version: next, path: note.path, from: null, kind: "save", body: text, writer, at: now, hash, merged: false, clash: true, resolves: null }),
        stmt(`UPDATE nexus_notes SET last_version = ?, clash = ${CLASH_STILL_OPEN} WHERE id = ?`, next, note.id),
      ], attempt);
      return done
        ? { result: "clash", path, latest: { version: head.version, text: head.body }, incoming: { version: next, text } }
        : undefined;
    };

    // No base. On a live note that is a save made without looking at it: a clash, never an overwrite. On a deleted
    // note there is nothing to overwrite, so the save brings it back.
    if (base === undefined) return note.deleted ? keep(text, false) : keepAsClash();

    const started = await versionOf(sql, note.id, base);
    if (!started) throw new Refusal(400, `Version ${base} is not a version of ${path}.`);
    if (started.clash) throw new Refusal(400, `Version ${base} is a clash version. Start from the latest version (${note.head_version}).`);

    if (base === note.head_version) return keep(text, false);

    // The note moved on since the writer started. A deleted note has nothing to merge into: a clash.
    if (note.deleted) return keepAsClash();
    const merged = mergeText(started.body, head.body, text);
    return merged === null ? keepAsClash() : keep(merged, true);
  });
}

export async function move(host: NexusHost, caller: Caller, fromInput: unknown, toInput: unknown): Promise<{ result: "moved"; path: string; version: number }> {
  const from = vaultPath(fromInput, "path to move from");
  const to = vaultPath(toInput, "path to move to");
  requireWrite(caller, from);
  requireWrite(caller, to);
  const writer = caller.name;
  const { sql } = host;

  return untilCommitted(async (attempt) => {
    const now = host.clock.now();
    const note = await noteAt(sql, from);
    if (!note || note.deleted) throw noNote(from);
    const occupied = await sql.first<{ n: number }>("SELECT 1 AS n FROM nexus_notes WHERE path = ? AND deleted = 0", [to]);
    if (occupied) throw new Refusal(409, `There is already a note at ${to}. Nothing was moved.`);

    const head = await headOf(sql, note);
    const next = note.last_version + 1;
    const done = await commit(sql, [
      insertVersion({ noteId: note.id, version: next, path: to, from, kind: "move", body: head.body, writer, at: now, hash: head.hash, merged: false, clash: false, resolves: null }),
      stmt(
        `UPDATE nexus_notes SET path = ?, head_version = ?, head_at = ?, last_version = ?, clash = ${CLASH_STILL_OPEN} WHERE id = ?`,
        to, next, now, next, note.id,
      ),
    ], attempt);
    return done ? { result: "moved" as const, path: to, version: next } : undefined;
  });
}

export async function remove(host: NexusHost, caller: Caller, pathInput: unknown): Promise<{ result: "deleted"; path: string; version: number }> {
  const path = vaultPath(pathInput);
  requireWrite(caller, path);
  const writer = caller.name;
  const { sql } = host;

  return untilCommitted(async (attempt) => {
    const now = host.clock.now();
    const note = await noteAt(sql, path);
    if (!note || note.deleted) throw noNote(path);

    const head = await headOf(sql, note);
    const next = note.last_version + 1;
    const done = await commit(sql, [
      insertVersion({ noteId: note.id, version: next, path, from: null, kind: "delete", body: head.body, writer, at: now, hash: head.hash, merged: false, clash: false, resolves: null }),
      stmt(
        `UPDATE nexus_notes SET deleted = 1, head_version = ?, head_at = ?, last_version = ?, clash = ${CLASH_STILL_OPEN} WHERE id = ?`,
        next, now, next, note.id,
      ),
    ], attempt);
    return done ? { result: "deleted" as const, path, version: next } : undefined;
  });
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface NoteRead {
  path: string;
  version: VersionRow;
  /** Whether the note is flagged: a clash version waits beside it. */
  flagged: boolean;
}

/** One note: its latest version, or the one asked for (which a deleted note still gives). */
export async function readNote(host: NexusHost, caller: Caller, pathInput: unknown, versionInput?: unknown): Promise<NoteRead> {
  const path = vaultPath(pathInput);
  requireRead(caller, path);
  const asked = wholeNumber(versionInput, "version");
  const note = await noteAt(host.sql, path);
  if (!note) throw noNote(path);
  if (asked === undefined && note.deleted) throw new Refusal(404, `The note at ${path} was deleted. Its history can still be read.`);
  const version = await versionOf(host.sql, note.id, asked ?? note.head_version);
  if (!version) throw new Refusal(404, `The note at ${path} has no version ${asked}.`);
  return { path: note.path, version, flagged: note.clash === 1 };
}

/** A note's versions, oldest first, deleted notes included. */
export async function readHistory(host: NexusHost, caller: Caller, pathInput: unknown): Promise<{ path: string; versions: VersionRow[] }> {
  const path = vaultPath(pathInput);
  requireRead(caller, path);
  const note = await noteAt(host.sql, path);
  if (!note) throw noNote(path);
  const versions = await host.sql.all<VersionRow>("SELECT * FROM nexus_versions WHERE note_id = ? ORDER BY version", [note.id]);
  return { path: note.path, versions: versions.map((v) => withoutHiddenOrigin(caller, v)) };
}

/**
 * A move's old path is only shown to a caller who may read it. A note that was moved out of a folder the caller
 * cannot see keeps its place in the history, and the old name stays private.
 */
function withoutHiddenOrigin(caller: Caller, v: VersionRow): VersionRow {
  return v.from_path !== null && !mayRead(caller, v.from_path) ? { ...v, from_path: null } : v;
}

export interface ListedNote {
  path: string;
  version: number;
  at: number;
  clash: boolean;
}

/**
 * The live notes under a folder (or every one) that the caller may read, by path. A folder is a whole name: `Ideas`
 * is not `Ideas2`. A folder the caller may not read lists as empty, never as forbidden.
 */
export async function list(host: NexusHost, caller: Caller, folder: string | null): Promise<ListedNote[]> {
  const prefix = folder === null ? null : `${folder}/`;
  const rows = prefix === null
    ? await host.sql.all<NoteRow>("SELECT * FROM nexus_notes WHERE deleted = 0 ORDER BY path")
    // substr counts characters, so the length is in characters too (an emoji is one, though JS counts two).
    : await host.sql.all<NoteRow>(
      "SELECT * FROM nexus_notes WHERE deleted = 0 AND substr(path, 1, ?) = ? ORDER BY path",
      [[...prefix].length, prefix],
    );
  return rows
    .filter((n) => mayRead(caller, n.path))
    .map((n) => ({ path: n.path, version: n.head_version, at: n.head_at, clash: n.clash === 1 }));
}

const SEARCH_PAGE = 200;

/**
 * A plain text search over the latest version of every live note: the words as typed (a % or a _ is just a
 * character), upper and lower case alike. The texts are read a page at a time and compared here rather than with
 * LIKE, which D1 limits to a 50-byte pattern, so a long phrase would work in a test and fail in production.
 */
export async function search(host: NexusHost, caller: Caller, queryInput: unknown): Promise<Array<{ path: string; version: number }>> {
  if (typeof queryInput !== "string" || queryInput === "") throw new Refusal(400, "A search needs some words to look for.");
  const wanted = queryInput.toLowerCase();
  const found: Array<{ path: string; version: number }> = [];
  let after = 0;
  for (;;) {
    const page = await host.sql.all<{ id: number; path: string; version: number; body: string }>(
      `SELECT n.id AS id, n.path AS path, n.head_version AS version, v.body AS body
         FROM nexus_notes n JOIN nexus_versions v ON v.note_id = n.id AND v.version = n.head_version
        WHERE n.deleted = 0 AND n.id > ? ORDER BY n.id LIMIT ${SEARCH_PAGE}`,
      [after],
    );
    for (const row of page) if (mayRead(caller, row.path) && row.body.toLowerCase().includes(wanted)) found.push({ path: row.path, version: row.version });
    if (page.length < SEARCH_PAGE) break;
    after = page[page.length - 1].id;
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const DEFAULT_CHANGES = 100;
export const MAX_CHANGES = 500;

/**
 * Every version after a cursor that the caller may read, oldest first, and the cursor to carry on from. A cursor is
 * the place of the last version looked at, hidden ones included: a page that holds nothing the caller may read still
 * moves the cursor past them, so the caller carries on and never sees a Private/ version or is stuck behind one.
 * With nothing new the same cursor comes back, so asking again is always safe.
 */
export async function changes(host: NexusHost, caller: Caller, afterInput: unknown, limitInput: unknown): Promise<{ rows: VersionRow[]; next: string }> {
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
  const rows = await host.sql.all<VersionRow>("SELECT * FROM nexus_versions WHERE seq > ? ORDER BY seq LIMIT ?", [after, limit]);
  const visible = rows.filter((v) => mayRead(caller, v.path)).map((v) => withoutHiddenOrigin(caller, v));
  return { rows: visible, next: String(rows.length ? rows[rows.length - 1].seq : after) };
}
