// An agent's door to the encrypted vault. It is given the address, its own sign-in token, its own X25519 private key and the
// approval a person sealed to that key's public half (`nexus-agent approve-agent`). It opens the approval into the vault key, the
// vault id and the key number, keeps them in memory only, and then lists, reads, writes and deletes notes by their PATH, or reads
// and saves ONE note by its id, in the note format the plugin reads.
//
// THE KEY NEVER LEAVES MEMORY. It is held in a private field, never logged, never written, never put in an error message, and
// `close()` overwrites it. Nothing in this file touches a file, a clock other than the one it is given, or a Node module: it runs
// in Node and in a Cloudflare Worker, over the `fetch` it is given or the runtime's.
//
// BY PATH. The server knows a note only by a random id: the path is inside the encrypted record. So the vault reads what Nexus
// holds, opens the newest version of each note, and keeps a small index in memory: for each note its id, its version and its path.
// It does NOT keep a note's text: a vault of thousands of long notes would not fit in a Worker's memory. The first look at a vault
// asks Nexus for the newest version of each note (`heads`), a page at a time, and holds at most one page of blobs while it decrypts
// them; each later call asks only for what changed since (`changes`). A text is read from Nexus when a call needs it, one note at a
// time. One call runs at a time.
//
// BY ID. A writer that keeps its own note ids never needs the index. `connect` opens the approval and reads no note; `createNote`,
// `readNote` and `updateNote` then each send or read ONE note and nothing else, so a vault of any size costs them nothing.
//
// A WRITE NEVER OVERWRITES A NEWER TEXT BLIND. A save names the version it starts from. When Nexus says the note is at another
// version (409), `write` reads that version, and puts what this write changed on top of it with the three-way merge the plugin
// uses (@nexus/merge), from the text the write began with. If the two changed the same lines, nothing is merged: the agent's text is
// kept as a second note beside the first ("<name> (duplicate agent <date>).md"), so both survive. `updateNote` does not merge: when
// the note is not at the version the caller names it answers "changed-since" and changes nothing.

import { decryptNote, devicePublicKey, encryptNote, NexusCryptoError, openApproval } from "@nexus/crypto";
import { mergeText } from "@nexus/merge";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64";
import { AgentError } from "./errors";
import { Nexus, refusal, type FetchLike, type Reply } from "./nexus";
import { duplicateNotePath, isSafeNotePath } from "./paths";
import { startLibsodium } from "./wasm-gate";

export interface AgentOptions {
  /** The address Nexus's routes sit under, such as https://nexus.example.org/nexus/api. */
  address: string;
  /** The agent's sign-in token (`nexus-agent sign-in`). */
  token: string;
  /** The agent's X25519 private key: 32 bytes, or standard base64 of them (`nexus-agent keygen`). */
  privateKey: Uint8Array | string;
  /** The approval a person sealed to the agent's public key: bytes, or standard base64 (`nexus-agent approve-agent`). */
  approval: Uint8Array | string;
  /** The runtime's `fetch` when left out. */
  fetch?: FetchLike;
  /** How the agent is called in the name of a duplicate note it keeps. Defaults to "agent". */
  name?: string;
  /** The time, as a Date. Defaults to the runtime's clock. */
  now?: () => Date;
  /**
   * libsodium's WebAssembly, compiled: in a Cloudflare Worker, the module that `import wasm from "./nexus-agent.wasm"` gives (the build
   * writes that file beside nexus-agent.js). A Worker will not make code from bytes, so without it the built library cannot start there.
   * Leave it out in Node, which starts libsodium from the bytes inside the file. Only the first vault opened in a runtime uses it.
   */
  wasm?: WebAssembly.Module;
}

export interface WriteResult {
  /** Where the agent's text is now: the path it asked for, or a duplicate's when the note had changed on the same lines. */
  path: string;
  /** The version of that note. */
  version: number;
  /** False when the note already said exactly this, so nothing was saved. */
  saved: boolean;
  /** True when the note had changed meanwhile and the agent's change was put on top of the newer text. */
  merged: boolean;
  /** True when the two changes could not be merged: the agent's text is a second note, at `path`, and the first is as it was. */
  duplicate: boolean;
}

/** One note as the vault knows it without its text: the id Nexus knows it by, the version it is at, and its path. */
export interface NoteRef {
  id: string;
  path: string;
  version: number;
}

/** One note, read by its id. */
export interface NoteContent extends NoteRef {
  text: string;
}

/** What `updateNote` did: it saved the text as the next version, or the note was no longer at the version named and nothing was changed. */
export type UpdateResult =
  | { result: "saved"; id: string; path: string; version: number }
  | { result: "changed-since"; id: string; current: number };

/** What the vault holds of one note: not its text, which is read again when a call needs it. */
interface Entry {
  id: string;
  version: number;
  /** When the version was saved (Nexus's time), to pick one of two notes that share a path. */
  at: number;
  deleted: boolean;
  /** True when the vault key opened this version. A note that opened but names a path the plugin would refuse has `path` null all the same. */
  opened: boolean;
  /** Null when the note could not be opened, or names a path the plugin would refuse. */
  path: string | null;
}

interface Change {
  id: string;
  version: number;
  kind: "save" | "delete";
  kid: number;
  at: number;
  blob?: string;
}

/** A version of a note, opened: what the vault keeps of it, and its text (null when it could not be opened or names a path the plugin would refuse). */
interface Opened {
  entry: Entry;
  text: string | null;
}

/** What is counted while the first look at a vault opens its notes, to tell a wrong key from an empty vault. */
interface Tally {
  live: number;
  opened: number;
}

/**
 * Notes (or changes) asked for at a time. A page is read, opened and dropped before the next is asked for, so this is what sets how much of the
 * vault is held at once: 100 notes of a transcript's size is under 3 MB of blobs. Nexus's own default, and a page can still be shorter, which
 * the loop copes with.
 */
const PAGE = 100;
/** Notes asked for at a time while `connect` looks for one that opens with the key. */
const KEY_CHECK_PAGE = 10;
/** How many times a write looks again at a note that keeps changing under it. */
const WRITE_ROUNDS = 6;
/** How many notes' paths `updateNote` remembers, so an update of a note it has just saved or read does not read it again. */
const PATHS_KEPT = 1000;

const REASON_CLOSED = "This vault was closed, so its key is gone. Open it again.";

/** An older Nexus has no `heads` route: the first look at its vault reads the changes feed instead. */
class NoHeadsRoute extends Error {}

export class AgentVault {
  readonly #nexus: Nexus;
  readonly #vaultKey: Uint8Array;
  readonly #vaultId: string;
  readonly #kid: number;
  readonly #name: string;
  readonly #now: () => Date;
  readonly #entries = new Map<string, Entry>();
  /** The path of a note at a version, for the notes this vault has just made, read or saved by id. Newest last. */
  readonly #paths = new Map<string, { version: number; path: string }>();
  #cursor: string | undefined;
  #closed = false;
  #turn: Promise<unknown> = Promise.resolve();

  private constructor(nexus: Nexus, opened: { vaultKey: Uint8Array; vaultId: string; kid: number }, name: string, now: () => Date) {
    this.#nexus = nexus;
    this.#vaultKey = opened.vaultKey;
    this.#vaultId = opened.vaultId;
    this.#kid = opened.kid;
    this.#name = name;
    this.#now = now;
  }

  /**
   * Opens the approval and looks at the vault: it learns the path of every note. Refuses, with nothing sent but reads, when the
   * private key does not open the approval, when the approval is for another vault than the one the server holds, or when the key
   * opens none of the notes. For a writer that never needs the paths, `connect` does not look at the vault.
   */
  static async open(options: AgentOptions): Promise<AgentVault> {
    const vault = await AgentVault.#approved(options);
    try {
      await vault.#refresh(true);
    } catch (error) {
      vault.close();
      throw error;
    }
    return vault;
  }

  /**
   * Opens the approval and checks it against the server, and does not look at the vault: it asks for the vault's id and then for a few notes
   * at a time (10), only until one of them opens with the key, which is the proof that the key is the vault's. `createNote`, `readNote` and
   * `updateNote` then work on one note each and never look at the rest of the vault. The calls that go by path (`list`, `read`, `write`,
   * `remove`) still work: the first of them looks at the vault then. Refuses as `open` does, and a vault with no note cannot show a wrong key.
   */
  static async connect(options: AgentOptions): Promise<AgentVault> {
    const vault = await AgentVault.#approved(options);
    try {
      await vault.#proveKey();
    } catch (error) {
      vault.close();
      throw error;
    }
    return vault;
  }

  static async #approved(options: AgentOptions): Promise<AgentVault> {
    if (typeof options.token !== "string" || options.token.trim() === "") {
      throw new AgentError("bad-settings", "The agent's sign-in token is missing.");
    }
    const nexus = new Nexus(options.address, options.token, options.fetch);
    // libsodium waits for this before it makes its WebAssembly, so it comes before the first use of the encryption (src/wasm-gate.ts).
    startLibsodium(options.wasm);
    const privateKey = bytesOf(options.privateKey, 32, "private key");
    const approval = bytesOf(options.approval, undefined, "approval");
    let opened: Awaited<ReturnType<typeof openApproval>>;
    try {
      opened = await openApproval({ publicKey: await devicePublicKey(privateKey), privateKey }, approval);
    } catch (error) {
      if (!(error instanceof NexusCryptoError)) throw error;
      throw new AgentError("bad-approval", "The approval could not be opened with this private key. Check that the key and the approval belong together and that neither was changed.");
    } finally {
      privateKey.fill(0);
    }

    const vault = new AgentVault(nexus, opened, options.name ?? "agent", options.now ?? (() => new Date()));
    try {
      await vault.#checkVaultId();
    } catch (error) {
      vault.close();
      throw error;
    }
    return vault;
  }

  /** The vault's id. It names the vault and is not secret. */
  get vaultId(): string {
    return this.#vaultId;
  }

  /** The number of the vault key the agent holds. Not secret. */
  get kid(): number {
    return this.#kid;
  }

  /** The paths of the notes in the vault, sorted. A note that could not be opened, or whose path the plugin would refuse, is not listed. */
  list(): Promise<string[]> {
    return this.#serially(async () => {
      await this.#refresh(false);
      return [...this.#byPath().keys()].sort();
    });
  }

  /** The notes in the vault, by path: each one's path, id and version. The same notes `list` lists. */
  listNotes(): Promise<NoteRef[]> {
    return this.#serially(async () => {
      await this.#refresh(false);
      return [...this.#byPath()].map(([path, entry]) => ({ path, id: entry.id, version: entry.version })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    });
  }

  /** The text of the note at `path`. */
  read(path: string): Promise<string> {
    return this.#serially(async () => {
      this.#checkPath(path);
      await this.#refresh(false);
      const entry = this.#byPath().get(path);
      if (!entry) throw notFound(path);
      return this.#textOf(entry.id, entry.version, path);
    });
  }

  /**
   * Saves `text` as the note at `path`, a new note if there is none. See the top of this file for what happens when the note
   * changed meanwhile.
   */
  write(path: string, text: string): Promise<WriteResult> {
    return this.#serially(async () => {
      this.#checkPath(path);
      if (typeof text !== "string") throw new AgentError("bad-settings", "A note's text has to be text.");
      return this.#write(path, text);
    });
  }

  /** Deletes the note at `path`. Refuses when the note changed since it was looked at, so a newer text is never deleted unseen. */
  remove(path: string): Promise<void> {
    return this.#serially(async () => {
      this.#checkPath(path);
      await this.#refresh(false);
      const entry = this.#byPath().get(path);
      if (!entry) throw notFound(path);
      const reply = await this.#nexus.post("delete", { id: entry.id, base: entry.version });
      if (reply.status === 200) return; // the next look at the changes carries the delete into the index
      if (reply.status === 404) throw notFound(path);
      if (reply.status === 409) {
        throw new AgentError("changed", `The note at ${path} changed just now, so it was not deleted. Read it again and delete it if it should still go.`);
      }
      throw refusal(reply, "delete the note");
    });
  }

  /**
   * Makes a new note at `path` with `text`, and tells its id and version (1). It sends that one note and looks at nothing else, so it
   * does not know whether another note is already at the path: two notes at one path are two ids, and the plugin gives the path to
   * the one with the smaller id and moves the other to a duplicate path (see `write`, which looks first). Keep the id: `readNote`
   * and `updateNote` take it.
   */
  createNote(path: string, text: string): Promise<NoteRef> {
    return this.#serially(async () => {
      this.#checkPath(path);
      if (typeof text !== "string") throw new AgentError("bad-settings", "A note's text has to be text.");
      const id = newNoteId();
      const reply = await this.#nexus.post("save", { id, base: 0, kid: this.#kid, blob: await this.#seal(id, path, text) });
      if (reply.status !== 200 || reply.json.result !== "saved") throw refusal(reply, "save the note");
      this.#rememberPath(id, reply.json.version, path);
      return { id, path, version: reply.json.version };
    });
  }

  /** The note with this id, as it is now: its path, version and text. Reads that one note and nothing else. */
  readNote(id: string): Promise<NoteContent> {
    return this.#serially(async () => {
      this.#checkId(id);
      const opened = await this.#fetch(id, undefined);
      if (opened === null) throw noNoteWithId();
      if (opened.text === null || opened.entry.path === null) throw unreadable(id);
      this.#rememberPath(id, opened.entry.version, opened.entry.path);
      return { id, path: opened.entry.path, version: opened.entry.version, text: opened.text };
    });
  }

  /**
   * Saves `text` as the next version of the note with this id, only when the note is still at `version`. When it is not, the answer is
   * `changed-since` with the version it is at, and nothing is changed: nothing is merged and nothing is overwritten. The note keeps
   * its path. Touches that one note: it is read once to learn its path, unless this vault made, read or saved it just before.
   */
  updateNote(id: string, version: number, text: string): Promise<UpdateResult> {
    return this.#serially(async () => {
      this.#checkId(id);
      if (!Number.isInteger(version) || version < 1) throw new AgentError("bad-settings", "A note's version is a whole number from 1.");
      if (typeof text !== "string") throw new AgentError("bad-settings", "A note's text has to be text.");
      const path = await this.#pathAt(id, version);
      const reply = await this.#nexus.post("save", { id, base: version, kid: this.#kid, blob: await this.#seal(id, path, text) });
      if (reply.status === 200 && reply.json.result === "saved") {
        this.#rememberPath(id, reply.json.version, path);
        return { result: "saved", id, path, version: reply.json.version };
      }
      if (reply.status === 409 && typeof reply.json.current === "number") {
        this.#paths.delete(id);
        return { result: "changed-since", id, current: reply.json.current };
      }
      throw refusal(reply, "save the note");
    });
  }

  /** The ids of notes Nexus holds that this vault could not open, or whose path the plugin would refuse. They are not in `list`. Ids are not secret. */
  unreadableNotes(): string[] {
    return [...this.#entries.values()].filter((e) => !e.deleted && e.path === null).map((e) => e.id).sort();
  }

  /** Overwrites the key and refuses every call after. Safe to call again. */
  close(): void {
    this.#vaultKey.fill(0);
    this.#entries.clear();
    this.#paths.clear();
    this.#closed = true;
  }

  // ── the work ───────────────────────────────────────────────────────────────

  /** Runs calls one after another: a call that starts while another is open waits for it. */
  #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(() => {
      if (this.#closed) throw new AgentError("closed", REASON_CLOSED);
      return work();
    });
    this.#turn = run.catch(() => undefined);
    return run;
  }

  #checkPath(path: string): void {
    if (!isSafeNotePath(path)) {
      throw new AgentError("unsafe-path", "That is not a path a note can have here. It has to end in .md, sit under no hidden folder, and hold no empty step, \"..\", backslash or control character.");
    }
  }

  /** A note id is what Nexus accepts: 1 to 128 letters, digits, hyphens or underscores. Checked here so a wrong one is told plainly and is never sent. */
  #checkId(id: string): void {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new AgentError("bad-settings", "A note id is 1 to 128 letters, digits, hyphens or underscores: the id `createNote` told.");
    }
  }

  /** The approval is for the vault the server holds: the server keeps the vault id beside the wraps. */
  async #checkVaultId(): Promise<void> {
    const reply = await this.#nexus.get("wraps");
    if (reply.status !== 200) throw refusal(reply, "tell which vault it holds");
    const held: unknown = reply.json.vaultId;
    if (typeof held !== "string") {
      throw new AgentError("wrong-vault", "This server holds no vault yet. Set one up first (nexus-agent create-vault).");
    }
    if (held !== this.#vaultId) {
      throw new AgentError("wrong-vault", "The approval is for a different vault than the one this server holds.");
    }
  }

  /**
   * What Nexus holds, opened. The first time it is the newest version of each note (`heads`), later it is every change after the last
   * one seen. Either way a page at a time: the notes of a page are opened and their blobs dropped before the next page is asked for.
   */
  async #refresh(checkKey: boolean): Promise<void> {
    const tally: Tally = { live: 0, opened: 0 };
    const take = (page: Change[]) => this.#take(page, tally);
    if (this.#cursor !== undefined) {
      this.#cursor = await this.#pages("changes", this.#cursor, take);
      return;
    }
    let cursor: string;
    try {
      cursor = await this.#pages("heads", undefined, take);
    } catch (error) {
      if (!(error instanceof NoHeadsRoute)) throw error;
      cursor = await this.#pages("changes", undefined, take);
    }
    // The place is kept only once everything before it has been opened, so a fault half way is met again by the next look.
    this.#cursor = cursor;
    // A key that opens none of the notes there are is the wrong key: better told now than by a note written under it.
    if (checkKey && tally.live > 0 && tally.opened === 0) throw wrongKey();
  }

  /**
   * Asks for a route's pages from `after` to the end, `limit` at a time, and hands each page to `each`, which is done with it before the next is
   * asked for. When `each` answers true no more is asked for. Gives the cursor at the end.
   */
  async #pages(route: "changes" | "heads", after: string | undefined, each: (page: Change[]) => Promise<boolean | void>, limit = PAGE): Promise<string> {
    let cursor = after;
    for (;;) {
      const reply = await this.#nexus.get(route, { after: cursor, limit });
      if (route === "heads" && reply.status === 404) throw new NoHeadsRoute();
      const page: unknown = reply.json[route];
      if (reply.status !== 200 || !Array.isArray(page) || typeof reply.json.next !== "string") throw refusal(reply, "list its changes");
      const next: string = reply.json.next;
      if (page.length === 0) return next;
      if ((await each(page as Change[])) === true) return next;
      cursor = next;
    }
  }

  /**
   * A key that opens none of the notes there are is the wrong key: better told before anything is written under it than after. Asks for a few
   * notes at a time, only until one opens, so a vault of any size costs one small page. A vault with no note cannot show a wrong key.
   */
  async #proveKey(): Promise<void> {
    let live = 0;
    let proved = false;
    const look = async (page: Change[]): Promise<boolean> => {
      for (const change of page) {
        if (change.kind === "delete") continue;
        live++;
        if ((await this.#open(change)).entry.opened) return (proved = true);
      }
      return false;
    };
    try {
      await this.#pages("heads", undefined, look, KEY_CHECK_PAGE);
    } catch (error) {
      if (!(error instanceof NoHeadsRoute)) throw error;
      await this.#pages("changes", undefined, look, KEY_CHECK_PAGE);
    }
    if (live > 0 && !proved) throw wrongKey();
  }

  /** Opens the newest version of each note in a page that is newer than what the index holds, and puts what it keeps of them in the index. */
  async #take(page: Change[], tally: Tally): Promise<void> {
    const newest = new Map<string, Change>();
    for (const change of page) {
      const held = this.#entries.get(change.id);
      if (held !== undefined && change.version <= held.version) continue;
      const other = newest.get(change.id);
      if (other === undefined || change.version > other.version) newest.set(change.id, change);
    }
    for (const change of newest.values()) {
      const { entry } = await this.#open(change);
      this.#entries.set(change.id, entry);
      if (!entry.deleted) tally.live++;
      if (entry.opened) tally.opened++;
    }
  }

  /** One change, opened. A delete has no blob; a note that does not open is kept as unreadable and left out of the lists. */
  async #open(change: Change): Promise<Opened> {
    const base = { id: change.id, version: change.version, at: Number(change.at) || 0 };
    if (change.kind === "delete") return { entry: { ...base, deleted: true, opened: false, path: null }, text: null };
    const bytes = typeof change.blob === "string" ? decodeBase64(change.blob) : null;
    if (bytes === null) return { entry: { ...base, deleted: false, opened: false, path: null }, text: null };
    try {
      const note = await decryptNote(this.#vaultKey, { vaultId: this.#vaultId, noteId: change.id, kid: this.#kid }, bytes);
      const safe = isSafeNotePath(note.path);
      return { entry: { ...base, deleted: false, opened: true, path: safe ? note.path : null }, text: safe ? note.text : null };
    } catch (error) {
      if (error instanceof NexusCryptoError) return { entry: { ...base, deleted: false, opened: false, path: null }, text: null };
      throw error;
    }
  }

  /** One note read from Nexus and opened: its newest version, or the one asked for. Null when Nexus has no such note, or it was deleted. */
  async #fetch(id: string, version: number | undefined): Promise<Opened | null> {
    const reply = await this.#nexus.get("note", { id, version });
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw refusal(reply, "read the note it holds");
    const opened = await this.#open({ id, version: reply.json.version, kind: reply.json.kind, kid: reply.json.kid, at: reply.json.at, blob: reply.json.blob });
    return opened.entry.deleted ? null : opened;
  }

  /** The text of a note at a version the index holds, read from Nexus. `where` names the note in what is said when it cannot be read. */
  async #textOf(id: string, version: number, where: string): Promise<string> {
    const opened = await this.#fetch(id, version);
    if (opened === null) throw notFound(where);
    if (opened.text === null) throw unreadable(where);
    return opened.text;
  }

  /**
   * The path of a note at a version: remembered when this vault just saw it, else read from Nexus (one note). A version older than the
   * one remembered is a save that Nexus will refuse (the note is already past it), so the remembered path will do for that one.
   */
  async #pathAt(id: string, version: number): Promise<string> {
    const known = this.#paths.get(id);
    if (known !== undefined && known.version >= version) return known.path;
    const opened = await this.#fetch(id, version);
    if (opened === null) throw noNoteWithId();
    if (opened.entry.path === null) throw unreadable(id);
    return opened.entry.path;
  }

  /** Remembers the path of a note at a version, newest last, and forgets the oldest past PATHS_KEPT. */
  #rememberPath(id: string, version: number, path: string): void {
    this.#paths.delete(id);
    this.#paths.set(id, { version, path });
    if (this.#paths.size > PATHS_KEPT) this.#paths.delete(this.#paths.keys().next().value as string);
  }

  /** The live notes by path. When two share a path the one saved last wins, then the one with the larger id. */
  #byPath(): Map<string, Entry> {
    const found = new Map<string, Entry>();
    for (const entry of this.#entries.values()) {
      if (entry.deleted || entry.path === null) continue;
      const other = found.get(entry.path);
      if (other === undefined || entry.at > other.at || (entry.at === other.at && entry.id > other.id)) found.set(entry.path, entry);
    }
    return found;
  }

  async #write(path: string, text: string): Promise<WriteResult> {
    let began: string | undefined; // what the note said when this write began: the text its change is relative to
    let newId: string | undefined; // the id of a note that is new, kept across rounds so a save whose answer was lost is sent again as the same note
    let looked = false;
    const read = new Map<string, string>(); // the texts of versions this write has read after a 409, by `id#version`, so the next round does not read them again

    for (let round = 0; round < WRITE_ROUNDS; round++) {
      await this.#refresh(false);
      const entry = this.#byPath().get(path);
      let base = 0;
      let id: string;
      let sending = text;
      let merged = false;

      if (entry) {
        const current = read.get(`${entry.id}#${entry.version}`) ?? (await this.#textOf(entry.id, entry.version, path));
        if (!looked) began = current;
        if (current === text) return { path, version: entry.version, saved: false, merged: false, duplicate: false };
        id = entry.id;
        base = entry.version;
        if (looked) {
          // The note moved on since this write began. Read as Nexus holds it, the agent's change goes on top of it.
          const together = mergeText(began ?? "", current, text);
          if (together === null) return this.#keepBeside(path, text);
          sending = together;
          merged = true;
        }
      } else {
        newId ??= newNoteId();
        id = newId;
      }
      looked = true;

      const blob = await this.#seal(id, path, sending);
      const reply = await this.#nexus.post("save", { id, base, kid: this.#kid, blob });
      if (reply.status === 200 && reply.json.result === "saved") {
        // The index catches up with this save the next time the changes are read.
        const done: WriteResult = { path, version: reply.json.version, saved: true, merged, duplicate: false };
        return base === 0 ? this.#settlePath(id, done, sending) : done;
      }
      if (reply.status !== 409) throw refusal(reply, "save the note");
      // The note is at another version. Read that version, so the next round starts from what Nexus holds now.
      await this.#readVersion(id, reply.json.current, read);
    }
    throw new AgentError("changed", `The note at ${path} kept changing while it was being saved, so nothing more was written. Try again.`);
  }

  /**
   * A note that was new has been saved. Two notes made at one path before either writer saw the other's are two ids in Nexus, which
   * cannot tell. The plugin's rule (plugin/src/sync.ts `adoptNew`) is that the one with the smaller id keeps the path, and the writer
   * that holds the other one acts and loses nothing: when the two texts are the same it drops its own note, and when they differ it moves
   * its own note to a duplicate path, as an ordinary note. The agent follows the same rule, so a plugin that has neither note gets both.
   */
  async #settlePath(id: string, done: WriteResult, text: string): Promise<WriteResult> {
    await this.#refresh(false);
    const rival = [...this.#entries.values()].find((e) => !e.deleted && e.path === done.path && e.id !== id && e.id < id);
    const own = this.#entries.get(id);
    if (rival === undefined || own === undefined) return done;
    if ((await this.#textOf(rival.id, rival.version, done.path)) === text) {
      const dropped = await this.#nexus.post("delete", { id, base: own.version });
      if (dropped.status !== 200) throw refusal(dropped, "drop the copy it just made");
      return { path: done.path, version: rival.version, saved: false, merged: false, duplicate: false };
    }
    const taken = this.#byPath();
    const moved = duplicateNotePath(done.path, this.#name, this.#now(), (candidate) => taken.has(candidate));
    const reply = await this.#nexus.post("save", { id, base: own.version, kid: this.#kid, blob: await this.#seal(id, moved, text) });
    if (reply.status !== 200 || reply.json.result !== "saved") throw reply.status === 409 ? new AgentError("changed", `The note at ${done.path} changed while it was being moved aside. Try again.`) : refusal(reply, "move the note aside");
    return { path: moved, version: reply.json.version, saved: true, merged: false, duplicate: true };
  }

  /** The agent's text, kept as a note of its own beside `path`, which is left as it is. */
  async #keepBeside(path: string, text: string): Promise<WriteResult> {
    const taken = this.#byPath();
    const where = duplicateNotePath(path, this.#name, this.#now(), (candidate) => taken.has(candidate));
    const written = await this.#write(where, text);
    return { ...written, duplicate: true };
  }

  /** Reads one version Nexus says a note is at, into the index, so the retry sees it even if the changes feed has not yet. Its text goes in `read`. */
  async #readVersion(id: string, version: unknown, read: Map<string, string>): Promise<void> {
    if (typeof version !== "number" || version < 1) return;
    const reply: Reply = await this.#nexus.get("note", { id, version });
    if (reply.status !== 200) throw refusal(reply, "read the note it holds");
    const held = this.#entries.get(id);
    if (held !== undefined && held.version >= version) return;
    const { entry, text } = await this.#open({ id, version, kind: reply.json.kind, kid: reply.json.kid, at: reply.json.at, blob: reply.json.blob });
    this.#entries.set(id, entry);
    if (text !== null) read.set(`${id}#${version}`, text);
  }

  async #seal(id: string, path: string, text: string): Promise<string> {
    try {
      return encodeBase64(await encryptNote(this.#vaultKey, { vaultId: this.#vaultId, noteId: id, kid: this.#kid }, { path, text }));
    } catch (error) {
      if (!(error instanceof NexusCryptoError)) throw error;
      throw new AgentError("refused", "That note could not be encrypted: its text is too large.");
    }
  }
}

const notFound = (path: string): AgentError => new AgentError("not-found", `There is no note at ${path}.`);
const wrongKey = (): AgentError => new AgentError("wrong-key", "The approval's key opens none of the notes in this vault, so it is not this vault's key. Ask for a new approval.");
const noNoteWithId = (): AgentError => new AgentError("not-found", "There is no note with that id, or it was deleted.");
const unreadable = (what: string): AgentError => new AgentError("unreadable", `The note ${what} could not be opened with this vault's key, or names a path the plugin would refuse.`);

/** A random id for a note, made the first time it is saved: 16 random bytes in url-safe base64, as the plugin makes them. */
function newNoteId(): string {
  return encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** A key or an approval given as bytes or as base64: its bytes, a copy that is the vault's to overwrite. Never repeated in a message. */
function bytesOf(value: Uint8Array | string, length: number | undefined, what: string): Uint8Array {
  const bytes = typeof value === "string" ? decodeBase64(value.trim()) : value instanceof Uint8Array ? value.slice() : null;
  if (bytes === null || (length !== undefined ? bytes.length !== length : bytes.length === 0)) {
    throw new AgentError("bad-settings", `The agent's ${what} is missing or is not standard base64${length === undefined ? "" : ` of ${length} bytes`}.`);
  }
  return bytes;
}
