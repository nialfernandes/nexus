// The sync engine: keeps every note of a vault in step with Nexus, both ways, and encrypts every note before it leaves the
// device. It knows nothing of Obsidian. It is given a vault, `requestUrl`, the plugin's data, the vault's key (see
// unlock.ts) and a few small ports (see types.ts), so a test can run it on its own.
//
// WHAT NEXUS HOLDS. Only blobs: for each note an id this device made (random, never the path), a version number, the number
// of the vault key, and the encrypted record `{ path, text }`. It cannot read a note, merge two edits or search. So every note
// goes up through sealNote and comes down through openNote (blobs.ts), the merge of two edits is done here (packages/merge),
// and search is done here too (search.ts).
//
// WHAT IT KEEPS, per note path, in the plugin's data (see KnownNote in types.ts)
//   id         the note's id: made the first time the note is synced, and the same through every rename and move
//   version    the Nexus version the note last matched
//   hash       a fingerprint of the text it had then, so "edited since" can be told from "unchanged"
//   savedPath  the path inside the blob at that version, so a note renamed here is sent again even if its text is the same
// and the changes cursor of the last pull. Everything else is worked out from the vault and from Nexus.
//
// WITH NO KEY. While the unlock port holds no key the engine sends nothing and reads nothing, and the status line says that
// the vault is locked. Edits made meanwhile are noticed and go up on the first sync after the vault is unlocked.
//
// THE RULES THAT KEEP A NOTE FROM BEING LOST
//   - A blob that does not open (damaged, from another vault, another note or another key) is never shown and never written
//     into the vault. The note stays as it is here, the status line names the note's id, and the note is asked for again on
//     every sync after.
//   - A local edit goes up with the stored version as base. If the note has moved on, Nexus refuses; this device reads the
//     current blob, merges the two edits (and the version this device started from) on the device, and saves again. If the
//     edits cannot be merged, both are kept: the vault's text goes into a clash copy beside the note and Nexus's text goes
//     into the note.
//   - A change that comes down never overwrites a note with edits that have not gone up: the edit is sent first, with its
//     old base, and the merge happens as above.
//   - A note that is missing from the vault is never deleted from Nexus because of that. Only a delete the plugin is told
//     about is sent. A rename is not a delete: it is a new version of the same note with another path inside it.
//   - The first sync deletes nothing, on either side.
//   - A note is removed from the vault only when Nexus says it is gone: a delete version for it in the changes feed, or a
//     404 for that note when it is read. Any other answer to a read, a fault in Nexus (5xx), a lost sign-in (401) or no
//     network, says nothing about the note, so it is left as it is, the status line says what happened, and the note is
//     asked for again on the next sync (see fetchRemote).
//   - A path that comes down in a blob is not trusted: one that leaves the vault or points into a hidden folder is refused.
//   - A clash copy stays in the vault it was made in: it is not a note, so it is never sent (see notes.ts).
//   - A note that cannot be sent, or cannot be written here, is reported in the status line; it never stops the notes beside
//     it, and a later success elsewhere does not cover it up. A note the vault could not write is put aside for this sync
//     and tried again on every sync after, until it can be written (see retryPulls).
//   - A pull reads the feed to its end and works out where every touched note finally stands before it changes anything, so
//     a note that was saved and then deleted is never written down only to be removed again.
//
// EVERYTHING RUNS ONE AT A TIME. A sync, a push, a rename and a delete wait for the one before, so two of them never
// write the same note at once. Nothing that goes wrong is thrown into Obsidian: it becomes the status line.

import { NexusCryptoError } from "@nexus/crypto";
import { mergeText } from "@nexus/merge";
import { Unreadable, openNote, sealNote, type NoteContent } from "./blobs";
import { clashCopyName, duplicateNoteName, fingerprint, isNote, isSafeNotePath, nameOf } from "./notes";
import { createSearchIndex } from "./search";
import { NOT_SET_UP, isSetUp, newNoteId } from "./state";
import type { KnownNote, SyncDeps, SyncEngine } from "./types";
import type { VaultKeys } from "./unlock";

export const SYNC_EVERY_MS = 30_000;
export const EDIT_PAUSE_MS = 3_000;
/** How many times one save is merged and sent again after Nexus says the note moved on while it was being merged. */
const MERGE_ROUNDS = 4;
/** How many changes one call to the feed asks for. */
const FEED_PAGE = "500";

// What the status line says when something is wrong, in plain words. NOT_SET_UP (state.ts) is what it says before the
// server address and the user name have been entered.
const SIGNED_OUT = "Signed out. Open the Nexus settings and sign in.";
export const LOCKED = "Locked. This vault's key is not unlocked, so nothing is sent to or read from Nexus.";
const OFFLINE = "Offline. Nexus can't be reached, so changes will wait until it can.";
const NEXUS_TROUBLE = "Nexus had a problem just now. The plugin will try again.";
const SOMETHING_WRONG = "Something went wrong with a note. The plugin will try again.";
// When a note cannot be taken from Nexus: it stays as it is here, and it is asked for again on the next sync.
const TRIED_AGAIN = "It will be tried again on the next sync.";
const wouldNotTake = (path: string, why: unknown) =>
  typeof why === "string" && why !== "" ? `Nexus would not take ${nameOf(path)}: ${why}` : `Nexus would not take ${nameOf(path)}.`;
const wouldNotGive = (label: string, status: number) => `Nexus would not give ${label} just now (error ${status}). ${TRIED_AGAIN}`;
const tooBig = (path: string) => `${nameOf(path)} is too big to encrypt and send, so it was skipped.`;
/** The status line's words for a blob that did not open. It names the note's id and nothing else: the path is inside the blob. */
const unreadableNote = (id: string) =>
  `Nexus holds a version of the note ${id} that this vault's key does not open, so it was not used and the note here was left as it is. ${TRIED_AGAIN}`;
const unsafeNote = (id: string) => `Nexus holds a version of the note ${id} that names a place outside the notes of this vault, so it was not written. ${TRIED_AGAIN}`;

/** What the changes feed finally says about one note: its latest blob, or that it is deleted. */
type Standing = { live: true; version: number; blob: unknown } | { live: false };

/** One answer about a note, from a read of it. */
interface RemoteVersion {
  version: number;
  kind: "save" | "delete";
  blob: unknown;
}

interface Reply {
  status: number;
  json: any;
}

/** Thrown when a call that the work cannot go on without did not get through. The status line already says why. */
class Disconnected extends Error {}

/** Thrown when the key went away in the middle of the work. The status line says the vault is locked. */
class Locked extends Error {}

/**
 * Thrown when Nexus answered a read of a note with something other than the note or a 404, or handed over something that
 * cannot be used here (a path outside the vault): that says nothing about whether Nexus still has the note, so the note is
 * left as it is. The message is the status line's words for it.
 */
class Refused extends Error {}

/** Thrown when a note cannot be placed yet because a note that is about to move still holds its path. It is put aside without a word and tried again at the end of the sync, after the sends. */
class Waiting extends Error {}

interface Disk {
  has(path: string): boolean;
  notes(): string[];
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const timeText = (when: Date, now: Date): string => {
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  return sameDay ? time : `${when.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
};

export function createSyncEngine(deps: SyncDeps): SyncEngine {
  const { vault, http, data } = deps;

  let trouble: string | null = null;
  let lastSync: Date | null = null;
  /** Notes with something wrong that is not the connection, by note id (or by path for a note with no id yet). Named in the status line until the note is dealt with. */
  const stuck = new Map<string, string>();
  /** Whether every note in the vault has been looked at since Obsidian started (or came back to the front). */
  let scanned = false;
  /** Notes that have to be sent: edited, made here, renamed, or put back after a clash. */
  const dirty = new Set<string>();
  const editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let interval: ReturnType<typeof setInterval> | null = null;
  /** Syncs that are waiting or running: the clock does not queue another while one is. */
  let syncs = 0;
  let tail: Promise<void> = Promise.resolve();
  const index = createSearchIndex();
  /** The path of each known note by its id, kept beside data.notes and rebuilt at the start of every pull (see indexIds). */
  const byId = new Map<string, string>();
  /** Notes put aside quietly in this sync (see Waiting) and tried again before it ends. */
  const placeLater = new Set<string>();
  /** The path of a note that was opened this run but is not tracked here (yet), so a message about it can say its name. It is the device's own, read out of a blob, and is never sent anywhere. */
  const openedAs = new Map<string, string>();

  // ── what the engine knows ──────────────────────────────────────────────────

  const notes = (): Record<string, KnownNote> => data.notes;
  const signedIn = (): boolean => typeof data.token === "string" && data.token !== "";
  const unlocked = (): boolean => deps.unlock.keys() !== null;
  /** The plugin may talk to Nexus: it has been told where Nexus is and which user to be, it holds a token and the vault is unlocked. Until then it sends nothing. */
  const ready = (): boolean => isSetUp(data) && signedIn() && unlocked();
  const changed = (): void => deps.onStatus?.();
  const save = (): Promise<void> => deps.persist(data);

  /** The keys for one piece of work, asked for when the work needs them. Throws Locked when the vault is locked. */
  function keysNow(): VaultKeys {
    const keys = deps.unlock.keys();
    if (keys === null) throw new Locked();
    return keys;
  }

  function indexIds(): void {
    byId.clear();
    openedAs.clear();
    for (const [path, entry] of Object.entries(notes())) byId.set(entry.id, path);
  }

  /** Records that the note at `path` matches `version` of note `id`, whose text then was `text` and whose path in the blob was `savedPath`. */
  indexIds();

  function track(path: string, id: string, version: number, text: string, savedPath = path): void {
    notes()[path] = { id, version, hash: fingerprint(text), savedPath };
    byId.set(id, path);
    stuck.delete(id);
  }

  function untrack(path: string): void {
    const entry = notes()[path];
    if (!entry) return;
    delete notes()[path];
    byId.delete(entry.id);
    stuck.delete(entry.id);
  }

  /** Records that one note cannot be dealt with, and says so in the status line. `tell` also raises a notice, once. */
  function stick(key: string, message: string, tell = false): void {
    if (tell && !stuck.has(key)) deps.notify(message);
    stuck.set(key, message);
  }

  const reasonOf = (error: unknown): string => (error instanceof Error && error.message !== "" ? error.message : "the vault would not do it");

  /** True when the note's text is the one it had when it last matched Nexus, and the path is the one Nexus has for it. */
  function inStep(path: string, text: string): boolean {
    const entry = notes()[path];
    return entry !== undefined && entry.version > 0 && entry.hash === fingerprint(text) && entry.savedPath === path;
  }

  /** What a note is called in a message: its file name when this device knows it, else its id. */
  const labelOf = (id: string): string => {
    const path = byId.get(id) ?? openedAs.get(id);
    return path === undefined ? `the note ${id}` : nameOf(path);
  };

  function status(): string {
    if (!isSetUp(data)) return NOT_SET_UP;
    if (!signedIn()) return SIGNED_OUT;
    if (!unlocked()) return LOCKED;
    if (trouble !== null) return trouble;
    if (stuck.size > 0) {
      const [first] = stuck.values();
      return stuck.size === 1 ? first : `${first} (and ${stuck.size - 1} more)`;
    }
    return lastSync === null ? "Not synced yet." : `Last synced ${timeText(lastSync, deps.now())}`;
  }

  // ── running one thing at a time, and never throwing ────────────────────────

  function exclusive(job: () => Promise<void>): Promise<void> {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  }

  /** Runs a job that answers whether it got to the end without losing the connection, and tells the status line how it went. */
  async function pass(job: () => Promise<boolean>): Promise<void> {
    let finished = false;
    try {
      finished = await job();
    } catch (error) {
      if (error instanceof Disconnected || error instanceof Locked) {
        changed();
        return;
      }
      console.error("Nexus plugin:", error);
      trouble = SOMETHING_WRONG;
      changed();
      return;
    }
    if (!finished) {
      changed();
      return;
    }
    trouble = null;
    lastSync = deps.now();
    changed();
  }

  // ── talking to Nexus ───────────────────────────────────────────────────────

  /**
   * One call to Nexus. Null means it did not get through and the status line already says why (offline, signed out, locked,
   * or Nexus in trouble): the caller stops. Any other answer, a 409 refusal included, comes back as it is.
   */
  async function send(method: "GET" | "POST", route: string, options: { query?: Record<string, string>; body?: object } = {}): Promise<Reply | null> {
    if (!ready()) return null;
    const base = data.address.replace(/\/+$/, "");
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    let response;
    try {
      response = await http({
        url: `${base}/${route}${query}`,
        method,
        headers: { authorization: `Bearer ${data.token}` },
        ...(options.body ? { contentType: "application/json", body: JSON.stringify(options.body) } : {}),
        throw: false,
      });
    } catch {
      trouble = OFFLINE;
      return null;
    }
    let json: any = {};
    try {
      json = response.json ?? {};
    } catch {
      json = {};
    }
    if (response.status === 401) {
      // Nexus no longer knows this token: forget it, and send nothing more until the person signs in again.
      data.token = null;
      await save();
      return null;
    }
    if (response.status >= 500 || response.status === 429) {
      trouble = NEXUS_TROUBLE;
      return null;
    }
    return { status: response.status, json };
  }

  /**
   * A note's blob from Nexus: its latest version, or the one asked for. Null means one thing only: Nexus answered 404, it has no
   * such note (now) or version. Throws Disconnected when the call fails, and Refused for any other answer, so a refusal is
   * never read as "the note is gone".
   */
  async function fetchRemote(id: string, version?: number): Promise<RemoteVersion | null> {
    const reply = await send("GET", "note", { query: version === undefined ? { id } : { id, version: String(version) } });
    if (!reply) throw new Disconnected();
    if (reply.status === 200) return { version: reply.json.version, kind: reply.json.kind, blob: reply.json.blob };
    if (reply.status === 404) return null;
    throw new Refused(wouldNotGive(labelOf(id), reply.status));
  }

  /** A note as Nexus holds it, opened: null when Nexus has no such note or version. Throws Unreadable when the blob does not open. */
  async function readRemote(id: string, version?: number): Promise<(NoteContent & { version: number }) | null> {
    const found = await fetchRemote(id, version);
    if (!found) return null;
    return { version: found.version, ...(await openNote(keysNow(), id, found.blob)) };
  }

  /** The changes after a cursor to the end of the feed, folded into where each touched note finally stands. */
  async function readFeed(from: string): Promise<{ standing: Map<string, Standing>; next: string } | null> {
    const standing = new Map<string, Standing>();
    let after = from;
    for (;;) {
      const reply = await send("GET", "changes", { query: { after, limit: FEED_PAGE } });
      if (!reply) return null;
      if (reply.status !== 200) {
        trouble = NEXUS_TROUBLE;
        return null;
      }
      const { changes, next } = reply.json as { changes: Array<{ id: string; version: number; kind: "save" | "delete"; blob?: unknown }>; next: string };
      for (const change of changes) {
        standing.set(change.id, change.kind === "save" ? { live: true, version: change.version, blob: change.blob } : { live: false });
      }
      if (next === after) return { standing, next };
      after = next;
    }
  }

  // ── the vault ──────────────────────────────────────────────────────────────

  async function openDisk(): Promise<Disk> {
    const files = new Set(await vault.files());
    return {
      has: (path) => files.has(path),
      notes: () => [...files].filter(isNote),
      read: (path) => vault.read(path),
      async write(path, text) {
        await vault.write(path, text);
        files.add(path);
        if (isNote(path)) index.set(path, text);
      },
      async rename(from, to) {
        await vault.rename(from, to);
        files.delete(from);
        files.add(to);
        index.rename(from, to);
      },
      async remove(path) {
        await vault.remove(path);
        files.delete(path);
        index.remove(path);
      },
    };
  }

  /** The text of a file, or undefined when it is not there. */
  async function readIf(path: string): Promise<string | undefined> {
    try {
      return await vault.read(path);
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps both texts. The vault's text goes into a sibling note, Nexus's text goes into the note, the note stands on
   * Nexus's version, and a notice names both so the person can merge by hand and delete the copy. The copy stays in
   * this vault: it is not a note as far as syncing goes (see isNote), so it is never sent to Nexus.
   */
  async function keepBoth(disk: Disk, path: string, local: string, remote: NoteContent & { id: string; version: number }): Promise<void> {
    const copy = clashCopyName(path, deps.device, deps.now(), (taken) => disk.has(taken));
    await disk.write(copy, local);
    await disk.write(path, remote.text);
    track(path, remote.id, remote.version, remote.text, remote.path);
    deps.notify(
      `Both versions of ${nameOf(path)} were kept. Nexus's text is in the note and yours is in ${nameOf(copy)}. Merge them by hand, then delete the copy.`,
    );
  }

  // ── going up ───────────────────────────────────────────────────────────────

  /**
   * Sends one note now, with the stored version as base, and when Nexus says the note has moved on, merges and sends again.
   * False when Nexus could not be reached (or the vault is locked).
   */
  async function pushOne(first: string): Promise<boolean> {
    if (!isNote(first)) return true;
    if (!ready()) {
      dirty.add(first); // kept waiting: it goes up on the first sync after the plugin is set up, signed in and unlocked
      return false;
    }
    let path = first;
    for (let round = 0; round < MERGE_ROUNDS; round++) {
      const text = await readIf(path);
      if (text === undefined) return true; // gone: the delete event tells Nexus, and a note missing at start is left alone
      let entry = notes()[path];
      if (entry && inStep(path, text)) {
        stuck.delete(entry.id);
        return true;
      }
      if (!entry) {
        // The note's id is made and kept before the first save is sent, so that a save whose answer was lost is sent again as the same note.
        entry = { id: newNoteId(), version: 0, hash: "", savedPath: "" };
        notes()[path] = entry;
        byId.set(entry.id, path);
        await save();
      }

      const keys = keysNow();
      let blob: string;
      try {
        blob = await sealNote(keys, entry.id, { path, text });
      } catch (error) {
        if (!(error instanceof NexusCryptoError)) throw error;
        stick(entry.id, tooBig(path));
        return true;
      }
      const reply = await send("POST", "save", { body: { id: entry.id, base: entry.version, kid: keys.kid, blob } });
      if (!reply) {
        dirty.add(path);
        return false;
      }
      if (reply.status === 200 && reply.json.result === "saved") {
        // What was sent is what the note matches. Typing that went on while the call was open is an edit still to be sent.
        track(path, entry.id, reply.json.version, text);
        await save();
        return true;
      }
      if (reply.status !== 409) {
        stick(entry.id, wouldNotTake(path, reply.json.error));
        return true;
      }
      const next = await settle(path, entry, text);
      if (next === null) return true;
      path = next;
    }
    dirty.add(path); // Nexus kept moving on under the merges: the note is looked at again on the next sync
    await save();
    return true;
  }

  /**
   * Nexus refused a save because the note is at another version. Reads the note as Nexus holds it now, merges this device's
   * text into it, and leaves the note ready to be sent again from Nexus's version. Answers the note's path when the loop is to
   * send again, null when the note is settled (matched, or both texts kept).
   */
  async function settle(path: string, entry: KnownNote, text: string): Promise<string | null> {
    const remote = await readRemote(entry.id);
    if (remote === null) {
      // Nexus has no such note: another device deleted it, or this one's first save never reached it. The note goes up again, as a new one.
      untrack(path);
      return path;
    }
    if (remote.text === text && remote.path === path) {
      track(path, entry.id, remote.version, text);
      await save();
      return null;
    }

    const disk = await openDisk();
    // What this device started from. Without it the two edits cannot be told apart, so they are kept both.
    let started: NoteContent | null = null;
    if (entry.version > 0) {
      try {
        started = await readRemote(entry.id, entry.version);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
      }
    }
    const merged = remote.text === text ? text : started ? mergeText(started.text, remote.text, text) : null;
    if (merged === null) {
      await keepBoth(disk, path, text, { id: entry.id, ...remote });
      await save();
      return null;
    }

    if ((await readIf(path)) !== text) {
      // Typing went on while Nexus was asked. Nothing is changed: the note still stands on the version it had, so the next send is refused
      // again and is merged again, with what is typed now. (Standing on Nexus's version with the newer text would send it over Nexus's changes.)
      dirty.add(path);
      return null;
    }

    // A note renamed here keeps the name it was given here; otherwise it follows the name Nexus has now.
    let at = path;
    if (path === entry.savedPath && remote.path !== path && isSafeNotePath(remote.path) && !disk.has(remote.path)) {
      await disk.rename(path, remote.path);
      untrack(path);
      at = remote.path;
    }
    if (merged !== text) await disk.write(at, merged);
    // The note now stands on Nexus's version with Nexus's text, so what is in the vault is an edit on it, and goes up again.
    track(at, entry.id, remote.version, remote.text, remote.path);
    await save();
    return at;
  }

  /** pushOne for one note among others: what goes wrong with this note (the vault would not read or write it) is reported and the others still go. */
  async function pushNote(path: string): Promise<boolean> {
    try {
      return await pushOne(path);
    } catch (error) {
      if (error instanceof Disconnected || error instanceof Locked) {
        dirty.add(path); // the note was taken from the waiting set and did not get through: it waits again
        throw error;
      }
      const key = notes()[path]?.id ?? path;
      if (error instanceof Unreadable) {
        // The note's latest blob does not open, so there is nothing to merge into: the note here stays as it is, and it is read
        // again at the start of the next sync (if the blob is whole by then, the edit is merged and goes up).
        stick(error.id, unreadableNote(error.id), true);
        addPending(error.id);
        return true;
      }
      if (error instanceof Refused) {
        stick(key, error.message, true); // Nexus would not hand the note over: it is read again at the start of the next sync
        addPending(notes()[path]?.id ?? key);
        return true;
      }
      console.error("Nexus plugin:", error);
      stick(key, `Could not update ${nameOf(path)} (${reasonOf(error)}), so it was skipped.`, true);
      return true;
    }
  }

  /**
   * Sends every note in the dirty set, one at a time. A note leaves the set as it is taken; one that fails puts itself back,
   * and the rest are never taken, so a failure strands nothing. A few rounds, so a note made while sending goes up too.
   */
  async function pushDirty(): Promise<boolean> {
    for (let round = 0; round < 3 && dirty.size > 0; round++) {
      for (const path of [...dirty]) {
        dirty.delete(path);
        if (!(await pushNote(path))) return false;
      }
    }
    return true;
  }

  /** Looks at every note for one that is new or changed since it last matched Nexus (an edit made while Obsidian was closed or the vault was locked). */
  async function scan(): Promise<void> {
    const disk = await openDisk();
    for (const path of disk.notes()) {
      if (dirty.has(path)) continue;
      const text = await disk.read(path);
      index.set(path, text);
      if (!inStep(path, text)) dirty.add(path);
    }
    scanned = true;
  }

  // ── deletes ────────────────────────────────────────────────────────────────

  /** Tells Nexus about every note deleted here that it has not been told about yet. False when Nexus could not be reached. */
  async function flushDeletes(): Promise<boolean> {
    const queue = data.pendingDeletes ?? [];
    if (queue.length === 0) return true;
    const disk = await openDisk();
    for (let at = 0; at < queue.length; at++) {
      const { id, version, path, hash } = queue[at];
      // A note that is back (made again, or renamed back) with the text it had is the same note, and is no longer a delete.
      if (path !== undefined && hash !== undefined && notes()[path] === undefined && disk.has(path)) {
        const back = await disk.read(path);
        if (fingerprint(back) === hash) {
          track(path, id, version, back);
          continue;
        }
      }
      const reply = await send("POST", "delete", { body: { id, base: version } });
      if (!reply) {
        data.pendingDeletes = queue.slice(at);
        await save();
        return false;
      }
      // 200 or 404: Nexus has no live note there now. 409: the note was saved again elsewhere since, and that newer version
      // stands: the delete is not sent again, and the note comes down on the next pull.
    }
    data.pendingDeletes = [];
    await save();
    return true;
  }

  /** The vault lost this note (deleted, or renamed out of the notes): tell Nexus, or keep the delete until it can be told. */
  async function forget(path: string): Promise<boolean> {
    const entry = notes()[path];
    index.remove(path);
    if (!entry) return true; // never reached Nexus, or this plugin's own removal
    untrack(path);
    if (entry.version > 0) (data.pendingDeletes ??= []).push({ id: entry.id, version: entry.version, path, hash: entry.hash });
    await save();
    return flushDeletes();
  }

  // ── coming down ────────────────────────────────────────────────────────────

  function addPending(id: string): void {
    const waiting = (data.pendingPulls ??= []);
    if (!waiting.includes(id)) waiting.push(id);
  }

  /**
   * A note Nexus holds that this device has no entry for: written here, matched if the same text is already here, kept both if not.
   *
   * Two notes with one path (two devices made a note there before either saw the other's) are two ids in Nexus. The one with the
   * smaller id keeps the path, on every device alike. The device that holds the other one is the one that acts, and it loses nothing
   * and sends everything: when the two texts are the same it drops its own note (the other holds the text); when they differ it moves
   * its own note to a duplicate path (see duplicateNoteName), as an ordinary note that is sent, so the text is in Nexus and on every
   * device, and puts the other note at the path. A device that holds the winner leaves the other note alone until its own device has
   * moved it.
   */
  async function adoptNew(disk: Disk, id: string, version: number, remote: NoteContent, final: boolean): Promise<void> {
    const target = remote.path;
    const holder = notes()[target];
    if (holder && holder.version > 0 && holder.id !== id) {
      // The holder may be about to move (an edit of it is waiting to be sent, or Nexus has moved it already), so the first time the note waits.
      if (!final) throw new Waiting();
      if (id > holder.id) return; // this device's note keeps the path
      const here = disk.has(target) ? await disk.read(target) : undefined;
      if (here === undefined || here === remote.text) {
        (data.pendingDeletes ??= []).push({ id: holder.id, version: holder.version });
        untrack(target);
        if (here === undefined) await disk.write(target, remote.text);
        track(target, id, version, remote.text);
        await save();
        await flushDeletes();
        return;
      }
      // Different texts: this device's note moves to a duplicate path, and the other note takes the path.
      const moved = duplicateNoteName(target, deps.device, deps.now(), (taken) => disk.has(taken));
      await disk.rename(target, moved);
      delete notes()[target];
      notes()[moved] = holder; // the same note and the same id: Nexus is told the new path in a new version, which is what a rename is
      byId.set(holder.id, moved);
      await disk.write(target, remote.text);
      track(target, id, version, remote.text);
      await save();
      deps.notify(
        `Two notes were made at ${nameOf(target)}. Nexus's note is there, and yours is now ${nameOf(moved)}. Both are kept and synced; merge them by hand if you like.`,
      );
      await pushNote(moved);
      return;
    }
    if (!disk.has(target)) {
      await disk.write(target, remote.text);
      track(target, id, version, remote.text);
      return;
    }
    const local = await disk.read(target);
    if (local === remote.text) track(target, id, version, remote.text);
    else await keepBoth(disk, target, local, { id, version, ...remote });
  }

  /** A note that stands in Nexus: written here when it is new or unchanged here; kept for the push when it has edits Nexus has not seen. */
  async function applyLive(disk: Disk, id: string, now: Extract<Standing, { live: true }>, final = false): Promise<void> {
    if ((data.pendingDeletes ?? []).some((pending) => pending.id === id)) return; // deleted here and not yet told: it is not brought back
    const path = byId.get(id);
    const entry = path === undefined ? undefined : notes()[path];
    if (path !== undefined && entry && now.version <= entry.version) return; // seen already, or this plugin's own save coming back

    const remote = await openNote(keysNow(), id, now.blob);
    openedAs.set(id, remote.path);
    if (!isNote(remote.path)) return; // not a note as far as this plugin goes (an attachment, a file in .obsidian): never written here, and nothing to say about it
    if (!isSafeNotePath(remote.path)) throw new Refused(unsafeNote(id));
    if (path === undefined || !entry) {
      await adoptNew(disk, id, now.version, remote, final);
      return;
    }

    if (!disk.has(path)) {
      // The file is gone from the vault but no delete was seen: Nexus's note is put back, at the path it has now.
      untrack(path);
      await adoptNew(disk, id, now.version, remote, final);
      return;
    }
    const local = await disk.read(path);
    if (!inStep(path, local)) {
      dirty.add(path); // edits (or a rename) Nexus has not seen: sent with the old base, and merged on this device when Nexus refuses
      return;
    }
    // Unchanged here: Nexus's version replaces it, and follows it to its new path when it has moved and the new name is free. When the
    // new name is taken here the note keeps the name it has, and does not send the old one back: two devices must not rename it in turn.
    let at = path;
    if (remote.path !== path && !disk.has(remote.path)) {
      await disk.rename(path, remote.path);
      untrack(path);
      at = remote.path;
    }
    if (local !== remote.text) await disk.write(at, remote.text);
    track(at, id, now.version, remote.text);
  }

  /**
   * A note Nexus no longer has: removed here when it matches what Nexus last had; kept, and sent again as a new note, when it has edits.
   * Only called when Nexus said so: a delete version in the feed, or a 404 for the note. A refused or failed read never gets here.
   */
  async function applyGone(disk: Disk, id: string): Promise<void> {
    const path = byId.get(id);
    if (path === undefined) return; // not a note this device has: nothing to remove
    const entry = notes()[path];
    if (!entry || entry.version === 0) return;
    if (!disk.has(path)) {
      untrack(path);
      return;
    }
    if (inStep(path, await disk.read(path))) {
      await disk.remove(path); // removed first: if the vault will not, the note is still tracked and is not sent as a new one
      untrack(path);
      return;
    }
    untrack(path);
    dirty.add(path);
  }

  /**
   * Runs the work for one remote note and answers whether it got done. A note the vault cannot write (a locked file, a name
   * the system refuses), that Nexus would not hand over, or whose blob does not open, is reported and put on the list to be
   * tried again on the next sync, so it never stops the notes after it or the pulls after that, and the note is left as it
   * is. A lost connection still stops the pull: the cursor must not move past notes that were never looked at.
   */
  async function skipping(id: string, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (error instanceof Disconnected || error instanceof Locked) throw error;
      if (error instanceof Waiting) {
        placeLater.add(id);
        addPending(id); // the cursor moves past it, so it is also kept to be tried again on the next sync if this one ends early
        return false;
      }
      if (error instanceof Unreadable) {
        stick(id, unreadableNote(id), true);
      } else if (error instanceof Refused) {
        stick(id, error.message, true);
      } else {
        console.error("Nexus plugin:", error);
        stick(id, `Could not update ${labelOf(id)} here (${reasonOf(error)}). ${TRIED_AGAIN}`, true);
      }
      addPending(id);
      return false;
    }
  }

  /** Tries again each note that could not be taken on an earlier sync, with what Nexus has for it now. */
  async function retryPulls(): Promise<void> {
    const waiting = [...(data.pendingPulls ?? [])];
    if (waiting.length === 0) return;
    indexIds();
    const disk = await openDisk();
    for (const id of waiting) {
      const done = await skipping(id, async () => {
        const remote = await fetchRemote(id);
        if (remote && remote.kind === "save") await applyLive(disk, id, { live: true, version: remote.version, blob: remote.blob }, true);
        else await applyGone(disk, id); // a 404: Nexus no longer has it, so nothing comes down (any other answer threw, and the note stayed)
      });
      if (done) {
        data.pendingPulls = (data.pendingPulls ?? []).filter((waitingId) => waitingId !== id);
        stuck.delete(id);
      }
    }
    await save();
  }

  async function applyStanding(standing: Map<string, Standing>): Promise<void> {
    const disk = await openDisk();
    // Notes this device already has go first, so that one moved away from a path is out of the way when a new note comes to it.
    const live = [...standing].flatMap(([id, now]) => (now.live ? [[id, now] as const] : []));
    for (const [id, now] of live) if (byId.has(id)) await skipping(id, () => applyLive(disk, id, now));
    for (const [id, now] of live) if (!byId.has(id)) await skipping(id, () => applyLive(disk, id, now));
    for (const [id, now] of standing) {
      if (!now.live) await skipping(id, () => applyGone(disk, id));
    }
  }

  /** Tries again the notes that were put aside to wait for a path (see Waiting), now that the sends are done. A path still held is kept as a copy. */
  async function placeWaiting(): Promise<void> {
    if (placeLater.size === 0) return;
    const ids = [...placeLater];
    placeLater.clear();
    indexIds();
    const disk = await openDisk();
    for (const id of ids) {
      const done = await skipping(id, async () => {
        const remote = await fetchRemote(id);
        if (remote && remote.kind === "save") await applyLive(disk, id, { live: true, version: remote.version, blob: remote.blob }, true);
      });
      if (done) {
        data.pendingPulls = (data.pendingPulls ?? []).filter((waitingId) => waitingId !== id);
        stuck.delete(id);
      }
    }
    await save();
  }

  async function pull(cursor: string): Promise<boolean> {
    const feed = await readFeed(cursor);
    if (!feed) return false;
    indexIds();
    await applyStanding(feed.standing);
    const moved = data.cursor !== feed.next;
    data.cursor = feed.next;
    if (moved || feed.standing.size > 0) await save();
    return true;
  }

  // ── the first sync ─────────────────────────────────────────────────────────

  /**
   * Brings a vault that has never synced together with Nexus, and deletes nothing. A note only in Nexus comes down,
   * a note only in the vault goes up, the same text on both sides is left alone, and different text is a clash. Notes are
   * matched by path, since this device has no ids yet for what is in the vault.
   */
  async function firstSync(): Promise<boolean> {
    const feed = await readFeed("0");
    if (!feed) return false;
    indexIds();
    const disk = await openDisk();
    for (const [id, now] of feed.standing) {
      if (now.live) await skipping(id, () => applyLive(disk, id, now)); // deleted in Nexus: a note still in the vault is not removed, and goes up below
    }
    data.cursor = feed.next;
    await save();
    await scan();
    const sent = await pushDirty();
    if (sent) await placeWaiting();
    return sent;
  }

  // ── the engine ─────────────────────────────────────────────────────────────

  async function runSync(): Promise<boolean> {
    if (!ready()) {
      scanned = false; // edits may have gone unseen while signed out or locked: the first sync after looks at every note again
      return false;
    }
    if (!(await flushDeletes())) return false;
    if (data.cursor === null) return firstSync();
    await retryPulls();
    if (!(await pull(data.cursor))) return false;
    if (!scanned) await scan();
    const sent = await pushDirty();
    if (sent) await placeWaiting();
    return sent;
  }

  /** Reads every note into the search index, and drops the ones that have left the vault. The index needs no key and no Nexus. */
  async function reindex(): Promise<void> {
    try {
      const disk = await openDisk();
      const present = new Set(disk.notes());
      for (const path of present) index.set(path, await disk.read(path));
      for (const path of index.paths()) if (!present.has(path)) index.remove(path);
    } catch (error) {
      console.error("Nexus plugin: could not read the notes for search:", error);
    }
  }

  function sync(): Promise<void> {
    syncs++;
    return exclusive(() => pass(runSync)).finally(() => {
      syncs--;
    });
  }

  function edited(path: string): void {
    if (!isNote(path)) return;
    const waiting = editTimers.get(path);
    if (waiting !== undefined) clearTimeout(waiting);
    editTimers.set(
      path,
      setTimeout(() => {
        editTimers.delete(path);
        void exclusive(async () => {
          const text = await readIf(path);
          if (text !== undefined) index.set(path, text);
          // A vault that has never synced is brought together by its first sync, not by single edits.
          if (data.cursor === null) return;
          await pass(() => pushNote(path));
        });
      }, EDIT_PAUSE_MS),
    );
  }

  function dropEdit(path: string): void {
    const waiting = editTimers.get(path);
    if (waiting !== undefined) clearTimeout(waiting);
    editTimers.delete(path);
    dirty.delete(path);
    const entry = notes()[path];
    if (entry) stuck.delete(entry.id);
    stuck.delete(path);
  }

  return {
    sync,

    push: (path) => exclusive(() => pass(() => pushNote(path))),

    edited,

    renamed: (from, to) =>
      exclusive(() =>
        pass(async () => {
          dropEdit(from);
          const fromNote = isNote(from);
          const toNote = isNote(to);
          if (!fromNote && !toNote) return true;
          if (!toNote) return forget(from); // moved out of the notes: it is gone as far as Nexus is concerned
          if (!fromNote) {
            edited(to); // a file that became a note
            return true;
          }
          const entry = notes()[from];
          if (!entry) {
            // Never reached Nexus, or the echo of a rename this plugin made itself (its target is already known).
            index.rename(from, to);
            if (!notes()[to]) edited(to);
            return true;
          }
          // The same note under another path: its id stays, and the new path is sent inside a new version of it.
          delete notes()[from];
          notes()[to] = entry;
          byId.set(entry.id, to);
          index.rename(from, to);
          await save();
          return pushNote(to);
        }),
      ),

    deleted: (path) =>
      exclusive(() =>
        pass(async () => {
          dropEdit(path);
          return isNote(path) ? forget(path) : true;
        }),
      ),

    start() {
      if (interval !== null) clearInterval(interval);
      void exclusive(reindex);
      void sync();
      interval = setInterval(() => {
        if (syncs === 0) void sync();
      }, SYNC_EVERY_MS);
    },

    stop() {
      if (interval !== null) clearInterval(interval);
      interval = null;
      for (const waiting of editTimers.values()) clearTimeout(waiting);
      editTimers.clear();
    },

    cameToFront() {
      scanned = false; // files may have changed while the app was away
      void exclusive(reindex);
      return sync();
    },

    status,

    search: (query, limit) => index.search(query, limit),
  };
}
