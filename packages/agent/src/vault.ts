// An agent's door to the encrypted vault. It is given the address, its own sign-in token, its own X25519 private key and the
// approval a person sealed to that key's public half (`nexus-agent approve-agent`). It opens the approval into the vault key, the
// vault id and the key number, keeps them in memory only, and then lists, reads, writes and deletes notes by their PATH, in the
// note format the plugin reads.
//
// THE KEY NEVER LEAVES MEMORY. It is held in a private field, never logged, never written, never put in an error message, and
// `close()` overwrites it. Nothing in this file touches a file, a clock other than the one it is given, or a Node module: it runs
// in Node and in a Cloudflare Worker, over the `fetch` it is given or the runtime's.
//
// BY PATH. The server knows a note only by a random id: the path is inside the encrypted record. So the vault reads what Nexus
// holds (the changes feed), opens each note's latest version, and keeps a small index in memory: id, version, path and text. The
// first look at a vault opens every note once, and each later call asks only for what changed since. One call runs at a time.
//
// A WRITE NEVER OVERWRITES A NEWER TEXT BLIND. A save names the version it starts from. When Nexus says the note is at another
// version (409), the vault reads that version, and puts what this write changed on top of it with the three-way merge the plugin
// uses (@nexus/merge), from the text the write began with. If the two changed the same lines, nothing is merged: the agent's text is
// kept as a second note beside the first ("<name> (duplicate agent <date>).md"), so both survive.

import { decryptNote, devicePublicKey, encryptNote, NexusCryptoError, openApproval } from "@nexus/crypto";
import { mergeText } from "@nexus/merge";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64";
import { AgentError } from "./errors";
import { Nexus, refusal, type FetchLike } from "./nexus";
import { duplicateNotePath, isSafeNotePath } from "./paths";

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

/** What the vault holds of one note. */
interface Entry {
  id: string;
  version: number;
  /** When the version was saved (Nexus's time), to pick one of two notes that share a path. */
  at: number;
  deleted: boolean;
  /** True when the vault key opened this version. A note that opened but names a path the plugin would refuse has `note` null all the same. */
  opened: boolean;
  /** Null when the note could not be opened, or names a path the plugin would refuse. */
  note: { path: string; text: string } | null;
}

interface Change {
  id: string;
  version: number;
  kind: "save" | "delete";
  kid: number;
  at: number;
  blob?: string;
}

/** Changes asked for at a time: the most Nexus sends (a page can still be shorter, which the loop copes with). */
const PAGE = 500;
/** How many times a write looks again at a note that keeps changing under it. */
const WRITE_ROUNDS = 6;

const REASON_CLOSED = "This vault was closed, so its key is gone. Open it again.";

export class AgentVault {
  readonly #nexus: Nexus;
  readonly #vaultKey: Uint8Array;
  readonly #vaultId: string;
  readonly #kid: number;
  readonly #name: string;
  readonly #now: () => Date;
  readonly #entries = new Map<string, Entry>();
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
   * Opens the approval and looks at the vault. Refuses, with nothing sent but reads, when the private key does not open the
   * approval, when the approval is for another vault than the one the server holds, or when the key opens none of the notes.
   */
  static async open(options: AgentOptions): Promise<AgentVault> {
    if (typeof options.token !== "string" || options.token.trim() === "") {
      throw new AgentError("bad-settings", "The agent's sign-in token is missing.");
    }
    const nexus = new Nexus(options.address, options.token, options.fetch);
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
      await vault.#refresh(true);
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

  /** The text of the note at `path`. */
  read(path: string): Promise<string> {
    return this.#serially(async () => {
      this.#checkPath(path);
      await this.#refresh(false);
      const entry = this.#byPath().get(path);
      if (!entry?.note) throw notFound(path);
      return entry.note.text;
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

  /** The ids of notes Nexus holds that this vault could not open, or whose path the plugin would refuse. They are not in `list`. Ids are not secret. */
  unreadableNotes(): string[] {
    return [...this.#entries.values()].filter((e) => !e.deleted && e.note === null).map((e) => e.id).sort();
  }

  /** Overwrites the key and refuses every call after. Safe to call again. */
  close(): void {
    this.#vaultKey.fill(0);
    this.#entries.clear();
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

  /** What Nexus holds, opened: every change after the last one seen, and the latest of each note opened once. */
  async #refresh(checkKey: boolean): Promise<void> {
    const newest = new Map<string, Change>();
    let cursor = this.#cursor;
    for (;;) {
      const reply = await this.#nexus.get("changes", { after: cursor, limit: PAGE });
      if (reply.status !== 200 || !Array.isArray(reply.json.changes) || typeof reply.json.next !== "string") throw refusal(reply, "list its changes");
      for (const change of reply.json.changes as Change[]) {
        const held = this.#entries.get(change.id);
        if (held === undefined || change.version > held.version) newest.set(change.id, change);
      }
      const done = reply.json.changes.length === 0;
      cursor = reply.json.next;
      if (done) break;
    }

    let opened = 0;
    let live = 0;
    for (const change of newest.values()) {
      const entry = await this.#open(change);
      this.#entries.set(change.id, entry);
      if (!entry.deleted) live++;
      if (entry.opened) opened++;
    }
    // The place is kept only once what came before it has been opened, so a fault half way is met again by the next look.
    this.#cursor = cursor;
    // A key that opens none of the notes there are is the wrong key: better told now than by a note written under it.
    if (checkKey && live > 0 && opened === 0) {
      throw new AgentError("wrong-key", "The approval's key opens none of the notes in this vault, so it is not this vault's key. Ask for a new approval.");
    }
  }

  /** One change, opened. A delete has no blob; a note that does not open is kept as unreadable and left out of the lists. */
  async #open(change: Change): Promise<Entry> {
    const base = { id: change.id, version: change.version, at: Number(change.at) || 0 };
    if (change.kind === "delete") return { ...base, deleted: true, opened: false, note: null };
    const bytes = typeof change.blob === "string" ? decodeBase64(change.blob) : null;
    if (bytes === null) return { ...base, deleted: false, opened: false, note: null };
    try {
      const note = await decryptNote(this.#vaultKey, { vaultId: this.#vaultId, noteId: change.id, kid: this.#kid }, bytes);
      return { ...base, deleted: false, opened: true, note: isSafeNotePath(note.path) ? note : null };
    } catch (error) {
      if (error instanceof NexusCryptoError) return { ...base, deleted: false, opened: false, note: null };
      throw error;
    }
  }

  /** The live notes by path. When two share a path the one saved last wins, then the one with the larger id. */
  #byPath(): Map<string, Entry> {
    const found = new Map<string, Entry>();
    for (const entry of this.#entries.values()) {
      if (entry.deleted || entry.note === null) continue;
      const other = found.get(entry.note.path);
      if (other === undefined || entry.at > other.at || (entry.at === other.at && entry.id > other.id)) found.set(entry.note.path, entry);
    }
    return found;
  }

  async #write(path: string, text: string): Promise<WriteResult> {
    let began: string | undefined; // what the note said when this write began: the text its change is relative to
    let newId: string | undefined; // the id of a note that is new, kept across rounds so a save whose answer was lost is sent again as the same note
    let looked = false;

    for (let round = 0; round < WRITE_ROUNDS; round++) {
      await this.#refresh(false);
      const entry = this.#byPath().get(path);
      let base = 0;
      let id: string;
      let sending = text;
      let merged = false;

      if (entry?.note) {
        if (!looked) began = entry.note.text;
        if (entry.note.text === text) return { path, version: entry.version, saved: false, merged: false, duplicate: false };
        id = entry.id;
        base = entry.version;
        if (looked) {
          // The note moved on since this write began. Read as Nexus holds it, the agent's change goes on top of it.
          const together = mergeText(began ?? "", entry.note.text, text);
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
      await this.#readVersion(id, reply.json.current);
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
    const rival = [...this.#entries.values()].find((e) => !e.deleted && e.note?.path === done.path && e.id !== id && e.id < id);
    const own = this.#entries.get(id);
    if (rival?.note === undefined || rival.note === null || own === undefined) return done;
    if (rival.note.text === text) {
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

  /** Reads one version Nexus says a note is at, into the index, so the retry sees it even if the changes feed has not yet. */
  async #readVersion(id: string, version: unknown): Promise<void> {
    if (typeof version !== "number" || version < 1) return;
    const reply = await this.#nexus.get("note", { id, version });
    if (reply.status !== 200) throw refusal(reply, "read the note it holds");
    const held = this.#entries.get(id);
    if (held !== undefined && held.version >= version) return;
    this.#entries.set(id, await this.#open({ id, version, kind: reply.json.kind, kid: reply.json.kid, at: reply.json.at, blob: reply.json.blob }));
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

