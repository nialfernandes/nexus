// A stand-in for a Nexus server, held in memory, for the plugin's tests. It answers the same routes with the same
// words and shapes as a real Nexus does, so the plugin is tested against what it will meet, and the tests need no server
// running beside them.
//
// WHAT IS REAL AND WHAT IS NOT
//   - The rules are the server's rules, written out again here: a save that starts from an older version is merged line
//     by line (and kept as a clash when the same lines changed on both sides), nothing is ever overwritten, a move and a
//     delete are versions of their own, the changes feed is one running count, folder rights decide who may read and
//     write, and a token is got only through a device approval. The three-way merge is the server's, line for line.
//   - Nothing else is. There is no database: the notes are in arrays. Two requests never overlap, so none of the server's
//     care for two saves at one moment is needed. Search, creating identities and setting rights are left out because
//     the plugin never calls them.
//   - A request is a real `Request` and an answer a real `Response`, so a missing content type, a bad JSON body, a missing
//     or unknown token and a route that does not exist are refused the way the server refuses them.
//
// THE ROUTES (under the address the plugin is given; every answer is JSON, a refusal is `{ error: "<plain words>" }`)
//   POST save           { path, text, base?, resolves? }   200 { result: "saved" | "merged", path, version }, or 409 a clash
//                                                          { result: "clash", path, latest, incoming }
//   GET  note           ?path=P[&version=N]                200 the note, 404 no such note or version
//   GET  history        ?path=P                            200 { path, versions }, oldest first
//   GET  list           [?folder=F]                        200 { notes }
//   GET  changes        [?after=CURSOR][&limit=N]          200 { changes, next }
//   POST move           { from, to }                       200, 404 no such note, 409 `to` is a live note
//   POST delete         { path }                           200, 404 no such note
//   GET  tokens                                            the owner only: the tokens that work, never the token
//   POST token/revoke   { id }                             the owner only
//   POST device/start   { identity, label }                no credential: 200 { code, link, secret, expiresAt }
//   POST device/poll    { secret }                         no credential: 200 pending, or approved with the token once
//   GET  device/pending ?code=C                            the owner only
//   POST device/approve { code }                           the owner only
//   POST device/deny    { code }                           the owner only
//
// WHO IS CALLING. The owner's session cookie is the owner. `Authorization: Bearer <token>` is the identity the token was
// made for. No credential, an unknown token, a revoked one and a header that is not a Bearer one are all 401, before any
// route runs; only the device's own two calls need none. There are two identities: `owner`, who may write everywhere,
// and `agents`, who may write everywhere except under `Private/`.

import { createHash, randomBytes } from "node:crypto";

export const OWNER = "owner";
export const AGENTS = "agents";
/** Where the stand-in "lives": the address a plugin under test is given is ORIGIN + API. */
export const ORIGIN = "https://nexus.example.test";
export const API = "/api";
/** Where the approval page would be: the link a device is handed opens it. */
export const APPROVE_PATH = "/approve";
export const SIGNIN_LIFETIME_MS = 10 * 60 * 1000;

// ── words and shapes ─────────────────────────────────────────────────────────

class Refusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413, message: string) {
    super(message);
  }
}

const MAX_TEXT_BYTES = 1_000_000;
const MAX_PATH_BYTES = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isWholeText = (text: string): boolean => !LONE_SURROGATE.test(text);

/** The path as given, or a refusal that says why it is not a path in the vault. */
function vaultPath(value: unknown, what = "path"): string {
  if (typeof value !== "string" || value === "") throw new Refusal(400, `A ${what} is needed, such as Ideas/Podcast names.md.`);
  if (value.startsWith("/")) throw new Refusal(400, `The ${what} has to be inside the vault, so it cannot start with a slash.`);
  if (CONTROL.test(value) || value.includes("\\") || !isWholeText(value)) {
    throw new Refusal(400, `The ${what} holds a character a note's path cannot hold.`);
  }
  if (new TextEncoder().encode(value).length > MAX_PATH_BYTES) throw new Refusal(400, `The ${what} is too long.`);
  for (const step of value.split("/")) {
    if (step === "") throw new Refusal(400, `The ${what} has an empty folder or file name in it.`);
    if (step === "." || step === "..") throw new Refusal(400, `The ${what} has to stay inside the vault, so it cannot hold . or .. as a step.`);
  }
  return value;
}

function vaultFolder(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Refusal(400, "The folder has to be text.");
  return vaultPath(value.endsWith("/") ? value.slice(0, -1) : value, "folder");
}

/** The short hash kept with every version: FNV-1a (64 bits) over the text's UTF-8 bytes, as 16 hex characters. */
function shortHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

// ── the three-way line merge ─────────────────────────────────────────────────
// `base` is the version the writer started from, `ours` the note's latest text and `theirs` the text being saved. Each
// side's changes to the base are found as hunks. Hunks on different lines are both kept; hunks that touch the same lines
// differently are a clash (null); the same change made on both sides is taken once. A line keeps its line ending.

interface Hunk {
  start: number;
  end: number;
  lines: string[];
  side: 0 | 1;
}

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(from, i + 1));
      from = i + 1;
    }
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function hunksBetween(base: string[], other: string[], side: 0 | 1): Hunk[] | null {
  let prefix = 0;
  while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix && suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) suffix++;

  const a = base.slice(prefix, base.length - suffix);
  const b = other.slice(prefix, other.length - suffix);
  if (a.length === 0 && b.length === 0) return [];
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return null;

  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { start: prefix + i, end: prefix + i, lines: [], side };
      hunks.push(open);
    }
    if (i < a.length && (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      i++;
      open.end = prefix + i;
    } else {
      open.lines.push(b[j]!);
      j++;
    }
  }
  return hunks;
}

function overlap(x: Hunk, y: Hunk): boolean {
  const xEmpty = x.start === x.end;
  const yEmpty = y.start === y.end;
  if (xEmpty && yEmpty) return x.start === y.start;
  if (xEmpty) return y.start < x.start && x.start < y.end;
  if (yEmpty) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

const sameChange = (x: Hunk, y: Hunk): boolean =>
  x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((line, n) => line === y.lines[n]);

/** The merged text, or null when the two sides changed the same lines differently. */
function mergeText(baseText: string, oursText: string, theirsText: string): string | null {
  const base = splitLines(baseText);
  const ours = hunksBetween(base, splitLines(oursText), 0);
  const theirs = hunksBetween(base, splitLines(theirsText), 1);
  if (!ours || !theirs) return null;

  const all = [...ours, ...theirs].sort((x, y) =>
    x.start - y.start || Number(y.start === y.end) - Number(x.start === x.end) || x.side - y.side);

  const taken: Hunk[] = [];
  for (const hunk of all) {
    const last = taken[taken.length - 1];
    if (last && last.side !== hunk.side && overlap(last, hunk)) {
      if (sameChange(last, hunk)) continue;
      return null;
    }
    taken.push(hunk);
  }

  const out: string[] = [];
  let at = 0;
  for (const hunk of taken) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at));
  return out.join("");
}

// ── who may touch what ───────────────────────────────────────────────────────

type Access = "read" | "write" | "none";
interface FolderRight {
  path: string;
  access: Access;
}
interface Caller {
  name: string;
  rights: readonly FolderRight[];
}

/** The right with the longest folder that the path starts with decides; a path no right reaches is not allowed at all. */
function accessAt(caller: Caller, path: string): Access {
  if (caller.name === OWNER) return "write";
  let best: FolderRight | null = null;
  for (const right of caller.rights) {
    if (path.startsWith(right.path) && (best === null || right.path.length > best.path.length)) best = right;
  }
  return best === null ? "none" : best.access;
}
const mayRead = (caller: Caller, path: string): boolean => accessAt(caller, path) !== "none";

function requireRead(caller: Caller, path: string): void {
  if (!mayRead(caller, path)) throw new Refusal(403, `${caller.name} may not read ${path}.`);
}
function requireWrite(caller: Caller, path: string): void {
  if (accessAt(caller, path) !== "write") throw new Refusal(403, `${caller.name} may not write ${path}.`);
}

// ── the store ────────────────────────────────────────────────────────────────

type VersionKind = "save" | "move" | "delete";

interface NoteRow {
  id: number;
  path: string;
  deleted: boolean;
  head: number;
  headAt: number;
  last: number;
  clash: boolean;
}

interface VersionRow {
  noteId: number;
  version: number;
  seq: number;
  path: string;
  from: string | null;
  kind: VersionKind;
  body: string;
  writer: string;
  at: number;
  hash: string;
  merged: boolean;
  clash: boolean;
  resolves: number | null;
}

interface TokenRow {
  id: string;
  hash: string;
  identity: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

interface SigninRow {
  code: string;
  secretHash: string;
  /** The hash of the token the secret stands for: allowing the sign-in makes the token's row from it, so the token is never kept. */
  tokenHash: string;
  identity: string;
  label: string;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "collected";
}

/** What a route is handed once it is known who is calling. */
interface Call {
  caller: Caller;
  url: URL;
  /** The JSON body of a POST; empty for a GET. */
  body: Record<string, unknown>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const hex = (count: number): string => randomBytes(count).toString("hex");
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GONE = "That code has expired or has already been used.";

function wholeNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Refusal(400, `The ${what} has to be a whole number, a version of the note.`);
  }
  return value;
}

export interface Answer {
  status: number;
  /** The parsed JSON, or null when the answer was not JSON. */
  body: any;
  text: string;
}

export type Who = { cookie: string } | { bearer: string } | { authorization: string } | null;

export class StandInNexus {
  /** The owner's session, as the cookie a browser signed in as the owner would send. */
  readonly ownerCookie = `session=${hex(16)}`;

  private notes: NoteRow[] = [];
  private versions: VersionRow[] = [];
  private tokens: TokenRow[] = [];
  private signins: SigninRow[] = [];
  private readonly rights = new Map<string, FolderRight[]>([
    [AGENTS, [{ path: "", access: "write" }, { path: "Private/", access: "none" }]],
  ]);

  /** No notes and no versions, so a test starts from a feed that begins at its own first change. Identities and tokens stay. */
  emptyNotes(): void {
    this.notes = [];
    this.versions = [];
  }

  private now = (): number => Date.now();

  // ── finding things ─────────────────────────────────────────────────────────

  /** The note at a path: the live one, else the most recent deleted one, else undefined. */
  private noteAt(path: string): NoteRow | undefined {
    return this.notes.filter((n) => n.path === path).sort((a, b) => Number(a.deleted) - Number(b.deleted) || b.id - a.id)[0];
  }

  private versionOf(note: NoteRow, version: number): VersionRow | undefined {
    return this.versions.find((v) => v.noteId === note.id && v.version === version);
  }

  private headOf(note: NoteRow): VersionRow {
    const head = this.versionOf(note, note.head);
    if (!head) throw new Error(`note ${note.id} has no version ${note.head}`);
    return head;
  }

  /** True while a clash version exists that no later save resolved. */
  private clashOpen(note: NoteRow): boolean {
    return this.versions.some(
      (c) => c.noteId === note.id && c.clash && !this.versions.some((r) => r.noteId === note.id && r.resolves === c.version),
    );
  }

  private addVersion(note: NoteRow, v: Omit<VersionRow, "noteId" | "version" | "seq" | "hash"> & { hash?: string }): VersionRow {
    const row: VersionRow = {
      ...v,
      noteId: note.id,
      version: note.last + 1,
      seq: this.versions.reduce((most, r) => Math.max(most, r.seq), 0) + 1,
      hash: v.hash ?? shortHash(v.body),
    };
    this.versions.push(row);
    note.last = row.version;
    return row;
  }

  // ── writing ────────────────────────────────────────────────────────────────

  private save(caller: Caller, input: Record<string, unknown>) {
    const path = vaultPath(input.path);
    requireWrite(caller, path);
    if (typeof input.text !== "string") throw new Refusal(400, "A save needs the note's text (it can be empty).");
    const text = input.text;
    if (!isWholeText(text)) throw new Refusal(400, "The text holds a character that cannot be kept as UTF-8.");
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      throw new Refusal(413, `That note is too long to keep (the limit is ${MAX_TEXT_BYTES} bytes).`);
    }
    const base = wholeNumber(input.base, "base");
    const resolves = wholeNumber(input.resolves, "resolves");
    const writer = caller.name;
    const at = this.now();
    const note = this.noteAt(path);

    if (!note) {
      if (base !== undefined) throw new Refusal(404, `There is no note at ${path} to start from. Save it without a base to make it.`);
      if (resolves !== undefined) throw new Refusal(400, "There is no clash to resolve: the note is new.");
      const made: NoteRow = { id: this.notes.reduce((most, n) => Math.max(most, n.id), 0) + 1, path, deleted: false, head: 1, headAt: at, last: 0, clash: false };
      this.notes.push(made);
      this.addVersion(made, { path, from: null, kind: "save", body: text, writer, at, merged: false, clash: false, resolves: null });
      return { status: 200, json: { result: "saved", path, version: 1 } };
    }

    const head = this.headOf(note);

    if (resolves !== undefined) {
      if (base !== note.head) throw new Refusal(400, `A save that resolves a clash has to name the latest version (${note.head}) as its base.`);
      const clashed = this.versionOf(note, resolves);
      const already = this.versions.some((v) => v.noteId === note.id && v.resolves === resolves);
      if (!clashed || !clashed.clash) throw new Refusal(400, `Version ${resolves} is not a clash version of this note.`);
      if (already) throw new Refusal(400, `The clash in version ${resolves} was already resolved.`);
    }

    const keep = (body: string, wasMerged: boolean) => {
      const row = this.addVersion(note, { path: note.path, from: null, kind: "save", body, writer, at, merged: wasMerged, clash: false, resolves: resolves ?? null });
      note.deleted = false;
      note.head = row.version;
      note.headAt = at;
      note.clash = this.clashOpen(note);
      return { status: 200, json: { result: wasMerged ? "merged" : "saved", path, version: row.version } };
    };

    const keepAsClash = () => {
      const row = this.addVersion(note, { path: note.path, from: null, kind: "save", body: text, writer, at, merged: false, clash: true, resolves: null });
      note.clash = this.clashOpen(note);
      return {
        status: 409,
        json: { result: "clash", path, latest: { version: head.version, text: head.body }, incoming: { version: row.version, text } },
      };
    };

    // No base. On a live note that is a save made without looking at it: a clash, never an overwrite. On a deleted note
    // there is nothing to overwrite, so the save brings it back.
    if (base === undefined) return note.deleted ? keep(text, false) : keepAsClash();

    const started = this.versionOf(note, base);
    if (!started) throw new Refusal(400, `Version ${base} is not a version of ${path}.`);
    if (started.clash) throw new Refusal(400, `Version ${base} is a clash version. Start from the latest version (${note.head}).`);

    if (base === note.head) return keep(text, false);

    // The note moved on since the writer started. A deleted note has nothing to merge into: a clash.
    if (note.deleted) return keepAsClash();
    const merged = mergeText(started.body, head.body, text);
    return merged === null ? keepAsClash() : keep(merged, true);
  }

  private move(caller: Caller, fromInput: unknown, toInput: unknown) {
    const from = vaultPath(fromInput, "path to move from");
    const to = vaultPath(toInput, "path to move to");
    requireWrite(caller, from);
    requireWrite(caller, to);
    const note = this.noteAt(from);
    if (!note || note.deleted) throw new Refusal(404, `There is no note at ${from}.`);
    if (this.notes.some((n) => n.path === to && !n.deleted)) throw new Refusal(409, `There is already a note at ${to}. Nothing was moved.`);
    const head = this.headOf(note);
    const row = this.addVersion(note, { path: to, from, kind: "move", body: head.body, writer: caller.name, at: this.now(), hash: head.hash, merged: false, clash: false, resolves: null });
    note.path = to;
    note.head = row.version;
    note.headAt = row.at;
    note.clash = this.clashOpen(note);
    return { status: 200, json: { result: "moved", path: to, version: row.version } };
  }

  private remove(caller: Caller, pathInput: unknown) {
    const path = vaultPath(pathInput);
    requireWrite(caller, path);
    const note = this.noteAt(path);
    if (!note || note.deleted) throw new Refusal(404, `There is no note at ${path}.`);
    const head = this.headOf(note);
    const row = this.addVersion(note, { path, from: null, kind: "delete", body: head.body, writer: caller.name, at: this.now(), hash: head.hash, merged: false, clash: false, resolves: null });
    note.deleted = true;
    note.head = row.version;
    note.headAt = row.at;
    note.clash = this.clashOpen(note);
    return { status: 200, json: { result: "deleted", path, version: row.version } };
  }

  // ── reading ────────────────────────────────────────────────────────────────

  private note(caller: Caller, pathInput: unknown, versionInput: string | undefined) {
    const path = vaultPath(pathInput);
    requireRead(caller, path);
    let asked: number | undefined;
    if (versionInput !== undefined) asked = /^\d+$/.test(versionInput) ? wholeNumber(Number(versionInput), "version") : wholeNumber(Number.NaN, "version");
    const note = this.noteAt(path);
    if (!note) throw new Refusal(404, `There is no note at ${path}.`);
    if (asked === undefined && note.deleted) throw new Refusal(404, `The note at ${path} was deleted. Its history can still be read.`);
    const v = this.versionOf(note, asked ?? note.head);
    if (!v) throw new Refusal(404, `The note at ${path} has no version ${asked}.`);
    return {
      status: 200,
      json: {
        path: note.path, version: v.version, text: v.body, writer: v.writer, at: v.at, hash: v.hash,
        clash: note.clash, kind: v.kind, merged: v.merged, clashVersion: v.clash,
      },
    };
  }

  /** A move's old path is only shown to a caller who may read it. */
  private shown(caller: Caller, v: VersionRow): VersionRow {
    return v.from !== null && !mayRead(caller, v.from) ? { ...v, from: null } : v;
  }

  private history(caller: Caller, pathInput: unknown) {
    const path = vaultPath(pathInput);
    requireRead(caller, path);
    const note = this.noteAt(path);
    if (!note) throw new Refusal(404, `There is no note at ${path}.`);
    const rows = this.versions.filter((v) => v.noteId === note.id).sort((a, b) => a.version - b.version).map((v) => this.shown(caller, v));
    return {
      status: 200,
      json: {
        path: note.path,
        versions: rows.map((v) => ({
          version: v.version, kind: v.kind, writer: v.writer, at: v.at, hash: v.hash, merged: v.merged, clash: v.clash,
          ...(v.from === null ? {} : { from: v.from }),
          ...(v.resolves === null ? {} : { resolves: v.resolves }),
        })),
      },
    };
  }

  private list(caller: Caller, folderInput: unknown) {
    const folder = vaultFolder(folderInput);
    const prefix = folder === null ? null : `${folder}/`;
    const notes = this.notes
      .filter((n) => !n.deleted && (prefix === null || n.path.startsWith(prefix)) && mayRead(caller, n.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((n) => ({ path: n.path, version: n.head, at: n.headAt, clash: n.clash }));
    return { status: 200, json: { notes } };
  }

  private changes(caller: Caller, afterInput: string | undefined, limitInput: string | undefined) {
    let after = 0;
    if (afterInput !== undefined && afterInput !== "") {
      if (!/^\d{1,15}$/.test(afterInput)) throw new Refusal(400, "The cursor has to be the one a previous answer gave.");
      after = Number(afterInput);
    }
    let limit = 100;
    if (limitInput !== undefined && limitInput !== "") {
      limit = Number(limitInput);
      if (!Number.isInteger(limit) || limit < 1) throw new Refusal(400, "The limit has to be a whole number of changes, 1 or more.");
      limit = Math.min(limit, 500);
    }
    const rows = this.versions.filter((v) => v.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
    const changes = rows
      .filter((v) => mayRead(caller, v.path))
      .map((v) => this.shown(caller, v))
      .map((v) => ({
        path: v.path, version: v.version, kind: v.kind, writer: v.writer, at: v.at, hash: v.hash, merged: v.merged, clash: v.clash,
        ...(v.kind === "save" ? { text: v.body } : {}),
        ...(v.from === null ? {} : { from: v.from }),
        ...(v.resolves === null ? {} : { resolves: v.resolves }),
      }));
    return { status: 200, json: { changes, next: String(rows.length ? rows[rows.length - 1]!.seq : after) } };
  }

  // ── tokens ─────────────────────────────────────────────────────────────────

  private listTokens() {
    const tokens = this.tokens
      .filter((t) => !t.revoked)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      .map((t) => ({ id: t.id, identity: t.identity, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
    return { status: 200, json: { tokens } };
  }

  private revoke(idInput: unknown) {
    if (typeof idInput !== "string" || idInput === "") throw new Refusal(400, "Revoking a token needs its id.");
    const token = this.tokens.find((t) => t.id === idInput && !t.revoked);
    if (!token) throw new Refusal(404, "There is no token with that id.");
    token.revoked = true;
    return { status: 200, json: { result: "revoked", id: idInput } };
  }

  /** The caller a bearer token stands for, stamping the time it was used, or null for a token that is unknown or revoked. */
  private authenticate(token: string): Caller | null {
    const row = this.tokens.find((t) => t.hash === sha256(token) && !t.revoked);
    if (!row) return null;
    row.lastUsedAt = this.now();
    return { name: row.identity, rights: this.rights.get(row.identity) ?? [] };
  }

  // ── device approval ────────────────────────────────────────────────────────
  // A device asks for a sign-in and is handed a short code (safe to show), a link to the approval page and a long
  // secret only it knows. The owner allows or denies the code. After an allow, the device's first poll is handed a token,
  // once. The token is worked out from the secret: "nx_" + SHA-256("nexus device token:" + secret).

  private readonly tokenOf = (secret: string): string => `nx_${sha256(`nexus device token:${secret}`)}`;

  private start(origin: string, input: Record<string, unknown>) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (label === "") throw new Refusal(400, "A sign-in needs a label, such as lab-m or My iPhone.");
    if ([...label].length > 80) throw new Refusal(400, "The label is too long (the limit is 80 characters).");
    const identity = typeof input.identity === "string" ? input.identity : undefined;
    if (identity === undefined || (identity !== OWNER && !this.rights.has(identity))) {
      throw new Refusal(404, `There is no identity called ${identity ?? "(none given)"}.`);
    }
    const secret = hex(32);
    const chars = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b & 31]);
    const code = `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
    const expiresAt = this.now() + SIGNIN_LIFETIME_MS;
    this.signins.push({ code, secretHash: sha256(secret), tokenHash: sha256(this.tokenOf(secret)), identity, label, expiresAt, status: "pending" });
    return { status: 200, json: { code, link: `${origin}${APPROVE_PATH}?code=${encodeURIComponent(code)}`, secret, expiresAt } };
  }

  /** The sign-in the owner is answering, or a refusal: no such code, or a code that has expired or been answered already. */
  private waitingFor(codeInput: unknown): SigninRow {
    if (typeof codeInput !== "string" || codeInput === "") throw new Refusal(400, "A code is needed.");
    const row = this.signins.find((s) => s.code === codeInput);
    if (!row) throw new Refusal(404, "There is no sign-in with that code.");
    if (row.status !== "pending" || row.expiresAt <= this.now()) throw new Refusal(410, GONE);
    return row;
  }

  /** What the approval page shows. */
  private pending(codeInput: unknown) {
    const row = this.waitingFor(codeInput);
    return { status: 200, json: { code: row.code, identity: row.identity, label: row.label, expiresAt: row.expiresAt } };
  }

  private approve(codeInput: unknown) {
    const row = this.waitingFor(codeInput);
    this.tokens.push({ id: hex(8), hash: row.tokenHash, identity: row.identity, label: row.label, createdAt: this.now(), lastUsedAt: null, revoked: false });
    row.status = "approved";
    return { status: 200, json: { result: "approved", code: row.code, identity: row.identity, label: row.label } };
  }

  private deny(codeInput: unknown) {
    const row = this.waitingFor(codeInput);
    row.status = "denied";
    return { status: 200, json: { result: "denied", code: row.code, identity: row.identity, label: row.label } };
  }

  private poll(secretInput: unknown) {
    if (typeof secretInput !== "string" || secretInput === "") throw new Refusal(400, "A poll needs the secret the device was given.");
    const row = this.signins.find((s) => s.secretHash === sha256(secretInput));
    if (!row) throw new Refusal(404, "There is no sign-in for that secret.");
    if (row.status === "collected") throw new Refusal(410, GONE);
    if (row.status === "denied") throw new Refusal(403, "The owner denied this sign-in.");
    if (row.expiresAt <= this.now()) throw new Refusal(410, GONE);
    if (row.status === "pending") return { status: 200, json: { status: "pending" } };
    row.status = "collected";
    return { status: 200, json: { status: "approved", token: this.tokenOf(secretInput), identity: row.identity, label: row.label } };
  }

  // ── the front door ─────────────────────────────────────────────────────────

  private readonly routes: readonly Route[] = [
    { method: "POST", name: "save", who: "identity", run: (c) => this.save(c.caller, c.body) },
    { method: "GET", name: "note", who: "identity", run: (c) => this.note(c.caller, c.url.searchParams.get("path") ?? undefined, c.url.searchParams.get("version") ?? undefined) },
    { method: "GET", name: "history", who: "identity", run: (c) => this.history(c.caller, c.url.searchParams.get("path") ?? undefined) },
    { method: "GET", name: "list", who: "identity", run: (c) => this.list(c.caller, c.url.searchParams.get("folder") ?? undefined) },
    { method: "GET", name: "changes", who: "identity", run: (c) => this.changes(c.caller, c.url.searchParams.get("after") ?? undefined, c.url.searchParams.get("limit") ?? undefined) },
    { method: "POST", name: "move", who: "identity", run: (c) => this.move(c.caller, c.body.from, c.body.to) },
    { method: "POST", name: "delete", who: "identity", run: (c) => this.remove(c.caller, c.body.path) },
    { method: "GET", name: "tokens", who: "owner", run: () => this.listTokens() },
    { method: "POST", name: "token/revoke", who: "owner", run: (c) => this.revoke(c.body.id) },
    { method: "POST", name: "device/start", who: "anyone", run: (c) => this.start(c.url.origin, c.body) },
    { method: "POST", name: "device/poll", who: "anyone", run: (c) => this.poll(c.body.secret) },
    { method: "GET", name: "device/pending", who: "owner", run: (c) => this.pending(c.url.searchParams.get("code") ?? undefined) },
    { method: "POST", name: "device/approve", who: "owner", run: (c) => this.approve(c.body.code) },
    { method: "POST", name: "device/deny", who: "owner", run: (c) => this.deny(c.body.code) },
  ];

  /** Answers one request to the API, the way a real Nexus does: sign-in first (except for a device's own two calls), then the route. */
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const name = url.pathname.startsWith(`${API}/`) ? url.pathname.slice(API.length + 1) : "";
      const named = this.routes.filter((r) => r.name === name);

      let caller: Caller | undefined;
      if (!named.some((r) => r.who === "anyone")) {
        caller = this.identify(request);
        if (!caller) return respond(401, { error: "Nexus needs the owner's sign-in or a token Nexus made." });
      }
      const route = named.find((r) => r.method === request.method);
      if (!route) return respond(named.length > 0 ? 405 : 404, { error: named.length > 0 ? `${name} does not take ${request.method}.` : "Nexus has no such route." });
      if (route.who === "owner" && caller?.name !== OWNER) return respond(403, { error: "Only the owner can do that." });

      const body = request.method === "POST" ? await readBody(request) : {};
      const answer = route.run({ caller: caller ?? { name: "", rights: [] }, url, body });
      return respond(answer.status, answer.json);
    } catch (error) {
      if (error instanceof Refusal) return respond(error.status, { error: error.message });
      throw error;
    }
  }

  /** Who is calling: a bearer token that works, or the owner's session. A header that is not Bearer is nobody, with no fallback to the cookie. */
  private identify(request: Request): Caller | undefined {
    const header = request.headers.get("authorization");
    if (header !== null) {
      const token = /^Bearer ([\x21-\x7e]+)$/.exec(header)?.[1];
      return (token === undefined ? null : this.authenticate(token)) ?? undefined;
    }
    const cookies = request.headers.get("cookie")?.split(/;\s*/) ?? [];
    return cookies.includes(this.ownerCookie) ? { name: OWNER, rights: [{ path: "", access: "write" }] } : undefined;
  }

  // ── the calls a test makes, as a given caller ──────────────────────────────

  /** One request as `who`. */
  async send(method: string, path: string, who: Who, body?: unknown): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (who && "cookie" in who) headers.cookie = who.cookie;
    if (who && "bearer" in who) headers.authorization = `Bearer ${who.bearer}`;
    if (who && "authorization" in who) headers.authorization = who.authorization;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetch(
      new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }),
    );
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, text };
  }

  /** The store's routes, called as `who`. */
  vault(who: Who) {
    const get = (route: string, params: Record<string, string | number | undefined>) => this.send("GET", `${API}/${route}${query(params)}`, who);
    const post = (route: string, body: unknown) => this.send("POST", `${API}/${route}`, who, body);
    return {
      save: (path: string, text: string, options: { base?: number; resolves?: number } = {}) => post("save", { path, text, ...options }),
      note: (path: string, version?: number) => get("note", { path, version }),
      history: (path: string) => get("history", { path }),
      list: (folder?: string) => get("list", { folder }),
      changes: (after?: string | number, limit?: number) => get("changes", { after, limit }),
      move: (from: string, to: string) => post("move", { from, to }),
      remove: (path: string) => post("delete", { path }),
    };
  }

  /** The routes only the owner may call. */
  manage(who: Who) {
    return {
      tokens: () => this.send("GET", `${API}/tokens`, who),
      revoke: (id: string) => this.send("POST", `${API}/token/revoke`, who, { id }),
    };
  }

  /** The device's calls, and the owner's answers to them. `who` is whoever makes the call. */
  device(who: Who = null) {
    const post = (route: string, body: unknown) => this.send("POST", `${API}/device/${route}`, who, body);
    return {
      start: (identity: string, label: string) => post("start", { identity, label }),
      pending: (code: string) => this.send("GET", `${API}/device/pending${query({ code })}`, who),
      approve: (code: string) => post("approve", { code }),
      deny: (code: string) => post("deny", { code }),
      poll: (secret: string) => post("poll", { secret }),
    };
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

/** Who may call a route: anyone (a device's own two), any identity, or only the owner. */
type Route = {
  method: "GET" | "POST";
  name: string;
  who: "anyone" | "identity" | "owner";
  run: (call: Call) => Answered;
};

interface Answered {
  status: number;
  json: unknown;
}

const respond = (status: number, json: unknown): Response =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** The JSON body of a POST. A body that is not declared JSON is refused, as the real Nexus refuses it. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new Refusal(400, "The request body has to be sent as application/json.");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new Refusal(400, "The request body has to be JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Refusal(400, "The request body has to be a JSON object.");
  return parsed as Record<string, unknown>;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
}
