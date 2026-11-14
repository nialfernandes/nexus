// The sync engine: keeps every note of a vault in step with Nexus, both ways. It knows nothing of Obsidian. It is given
// a vault, `requestUrl`, the plugin's data and a few small ports (see types.ts), so a test can run it on its own.
//
// WHAT IT KEEPS, per note path, in the plugin's data
//   versions[path]  the Nexus version the note last matched
//   hashes[path]    a fingerprint of the text it had then, so "edited since" can be told from "unchanged"
// and the changes cursor of the last pull. Everything else is worked out from the vault and from Nexus.
//
// THE RULES THAT KEEP A NOTE FROM BEING LOST
//   - A local edit goes up with the stored version as base. Nexus merges it with what changed meanwhile; if it cannot,
//     it keeps both, and the vault's text goes into a clash copy beside the note while Nexus's text goes into the note.
//   - A change that comes down never overwrites a note with edits that have not gone up: the edit is sent first (with
//     its old base) and Nexus does the merging.
//   - A note that is missing from the vault is never deleted from Nexus because of that. Only a delete or a rename the
//     plugin is told about is sent.
//   - The first sync deletes nothing, on either side.
//   - A note is removed from the vault only when Nexus says it is gone: a delete version for it in the changes feed (or
//     the old path of a move), or a 404 for that note when it is read. Any other answer to a read, a refusal (403), a
//     fault in Nexus (5xx), a lost sign-in (401) or no network, says nothing about the note, so it is left as it is, the
//     status line says what happened in plain words, and the note is asked for again on the next sync (see fetchNote).
//   - A clash copy stays in the vault it was made in: it is not a note, so it is never sent (see notes.ts).
//   - A note that cannot be sent, or cannot be written here, is reported by name in the status line; it never stops the
//     notes beside it, and a later success elsewhere does not cover it up. A note the vault could not write is put
//     aside for this sync and tried again on every sync after, until it can be written (see retryPulls).
//   - A note made again at a path another writer moved away from is a different note, whose versions start over: it is
//     brought down, or clashes with what is here, and is never skipped or overwritten (see `fresh`).
//   - A pull reads the feed to its end and works out where every touched note finally stands before it changes
//     anything, so a note that was saved and then moved or deleted is never written down only to be removed again,
//     and entries older than something this plugin itself did cannot bring a note back.
//
// EVERYTHING RUNS ONE AT A TIME. A sync, a push, a rename and a delete wait for the one before, so two of them never
// write the same note at once. Nothing that goes wrong is thrown into Obsidian: it becomes the status line.

import { clashCopyName, fingerprint, isNote, nameOf } from "./notes";
import { NOT_SET_UP, isSetUp } from "./state";
import type { SyncDeps, SyncEngine } from "./types";

export const SYNC_EVERY_MS = 30_000;
export const EDIT_PAUSE_MS = 3_000;

// What the status line says when something is wrong, in plain words. NOT_SET_UP (state.ts) is what it says before the
// server address and the user name have been entered.
const SIGNED_OUT = "Signed out. Open the Nexus settings and sign in.";
const OFFLINE = "Offline. Nexus can't be reached, so changes will wait until it can.";
const NEXUS_TROUBLE = "Nexus had a problem just now. The plugin will try again.";
const SOMETHING_WRONG = "Something went wrong with a note. The plugin will try again.";
const notAllowed = (path: string) => `Not allowed. Nexus does not let this device change ${path}.`;
const wouldNotTake = (path: string, why: unknown) =>
  typeof why === "string" && why !== "" ? `Nexus would not take ${nameOf(path)}: ${why}` : `Nexus would not take ${nameOf(path)}.`;
// When Nexus will not hand over a note it has: the note stays as it is here, and it is asked for again on the next sync.
const TRIED_AGAIN = "It will be tried again on the next sync.";
const notAllowedToRead = (path: string) => `Not allowed. Nexus does not let this device read ${path}. ${TRIED_AGAIN}`;
const wouldNotGive = (path: string, status: number) => `Nexus would not give ${nameOf(path)} just now (error ${status}). ${TRIED_AGAIN}`;

/** One version in the changes feed: a save carries its whole text, a move names where the note came from. */
interface Change {
  path: string;
  version: number;
  kind: "save" | "move" | "delete";
  text?: string;
  from?: string;
  /** The text of a save that could not be merged. Nexus keeps it beside the note; it is never the note's text. */
  clash?: boolean;
}

/** Where a path finally stands after a run of changes. */
type Standing =
  | {
      live: true;
      version: number;
      text: string | undefined;
      from?: string;
      /**
       * The path was vacated by a move earlier in the same run, so this is a different note from any this plugin stored a
       * version for at the path: a note's versions go with it when it moves, and a note made later starts again at 1.
       */
      fresh?: boolean;
    }
  | { live: false };

interface Reply {
  status: number;
  json: any;
}

/** Thrown when a call that the work cannot go on without did not get through. The status line already says why. */
class Disconnected extends Error {}

/**
 * Thrown when Nexus answered a read of a note with something other than the note or a 404: it would not hand the note
 * over (a refusal, or an answer this plugin does not know). That says nothing about whether Nexus still has the note, so
 * the note is left as it is. The message is the status line's words for it.
 */
class Refused extends Error {}

interface Disk {
  has(path: string): boolean;
  notes(): string[];
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Folds one change into where the notes stand. A move leaves its old path gone and carries the text to the new one. */
function replay(standing: Map<string, Standing>, change: Change, vacated: Set<string>): void {
  if (change.clash) return;
  if (change.kind === "save") {
    if (isNote(change.path)) {
      standing.set(change.path, { live: true, version: change.version, text: change.text ?? "", ...(vacated.has(change.path) ? { fresh: true } : {}) });
    }
    return;
  }
  if (change.kind === "delete") {
    if (isNote(change.path)) standing.set(change.path, { live: false });
    return;
  }
  const source = change.from === undefined ? undefined : standing.get(change.from);
  if (change.from !== undefined && isNote(change.from)) {
    standing.set(change.from, { live: false });
    vacated.add(change.from);
  }
  if (!isNote(change.path)) return;
  const origin = source?.live ? (source.from ?? change.from) : change.from;
  standing.set(change.path, {
    live: true,
    version: change.version,
    // A move carries no text. It is the source's text when this run saw it, else it is read from Nexus when needed.
    text: source?.live ? source.text : undefined,
    from: origin !== undefined && origin !== change.path && isNote(origin) ? origin : undefined,
    ...(vacated.has(change.path) ? { fresh: true } : {}),
  });
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
  /** Notes with something wrong that is not the connection (refused by Nexus, or not writable here), by path. Named in the status line until the note is dealt with. */
  const stuck = new Map<string, string>();
  /** Whether every note in the vault has been looked at since Obsidian started (or came back to the front). */
  let scanned = false;
  /** Notes that have to be sent: edited, made here, or put back after a clash. */
  const dirty = new Set<string>();
  const editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let interval: ReturnType<typeof setInterval> | null = null;
  /** Syncs that are waiting or running: the clock does not queue another while one is. */
  let syncs = 0;
  let tail: Promise<void> = Promise.resolve();

  // ── what the engine knows ──────────────────────────────────────────────────

  const versions = (): Record<string, number> => data.versions;
  const hashes = (): Record<string, string> => (data.hashes ??= {});
  const signedIn = (): boolean => typeof data.token === "string" && data.token !== "";
  /** The plugin may talk to Nexus: it has been told where Nexus is and which user to be, and it holds a token. Until then it sends nothing. */
  const ready = (): boolean => isSetUp(data) && signedIn();
  const changed = (): void => deps.onStatus?.();
  const save = (): Promise<void> => deps.persist(data);

  function mark(path: string, version: number, text: string): void {
    versions()[path] = version;
    hashes()[path] = fingerprint(text);
    stuck.delete(path);
  }

  function untrack(path: string): void {
    delete versions()[path];
    delete hashes()[path];
    stuck.delete(path);
  }

  /** Records that one note cannot be dealt with, and says so in the status line. `tell` also raises a notice, once. */
  function stick(path: string, message: string, tell = false): void {
    if (tell && !stuck.has(path)) deps.notify(message);
    stuck.set(path, message);
  }

  const reasonOf = (error: unknown): string => (error instanceof Error && error.message !== "" ? error.message : "the vault would not do it");

  /** True when the note's text is the one it had when it last matched Nexus. */
  const inStep = (path: string, text: string): boolean => versions()[path] !== undefined && hashes()[path] === fingerprint(text);

  function status(): string {
    if (!isSetUp(data)) return NOT_SET_UP;
    if (!signedIn()) return SIGNED_OUT;
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
      if (error instanceof Disconnected) {
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
   * One call to Nexus. Null means it did not get through and the status line already says why (offline, signed out, or
   * Nexus in trouble): the caller stops. Any other answer, a 409 clash and a 403 refusal included, comes back as it is.
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
   * A note's latest text from Nexus. Null means one thing only: Nexus answered 404, it has no such note (now). Throws
   * Disconnected when the call fails, and Refused for any other answer, so a refusal is never read as "the note is gone".
   */
  async function fetchNote(path: string): Promise<{ version: number; text: string } | null> {
    const reply = await send("GET", "note", { query: { path } });
    if (!reply) throw new Disconnected();
    if (reply.status === 200) return { version: reply.json.version, text: reply.json.text };
    if (reply.status === 404) return null;
    throw new Refused(reply.status === 403 ? notAllowedToRead(path) : wouldNotGive(path, reply.status));
  }

  /** The changes after a cursor to the end of the feed, folded into where each touched note finally stands. */
  async function readFeed(from: string): Promise<{ standing: Map<string, Standing>; next: string } | null> {
    const standing = new Map<string, Standing>();
    const vacated = new Set<string>();
    let after = from;
    for (;;) {
      const reply = await send("GET", "changes", { query: { after } });
      if (!reply) return null;
      if (reply.status !== 200) {
        trouble = NEXUS_TROUBLE;
        return null;
      }
      const { changes, next } = reply.json as { changes: Change[]; next: string };
      for (const change of changes) replay(standing, change, vacated);
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
      },
      async rename(from, to) {
        await vault.rename(from, to);
        files.delete(from);
        files.add(to);
      },
      async remove(path) {
        await vault.remove(path);
        files.delete(path);
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
  async function keepBoth(disk: Disk, path: string, local: string, remote: { version: number; text: string }): Promise<void> {
    const copy = clashCopyName(path, deps.device, deps.now(), (taken) => disk.has(taken));
    await disk.write(copy, local);
    await disk.write(path, remote.text);
    mark(path, remote.version, remote.text);
    deps.notify(
      `Both versions of ${nameOf(path)} were kept. Nexus's text is in the note and yours is in ${nameOf(copy)}. Merge them by hand, then delete the copy.`,
    );
  }

  // ── going up ───────────────────────────────────────────────────────────────

  /** Sends one note's text now, with the stored version as base. False when Nexus could not be reached. */
  async function pushOne(path: string): Promise<boolean> {
    if (!isNote(path)) return true;
    if (!ready()) {
      dirty.add(path); // kept waiting: it goes up on the first sync after the plugin is set up and signed in
      return false;
    }
    const text = await readIf(path);
    if (text === undefined) return true; // gone: the delete event tells Nexus, and a note missing at start is left alone
    const known = versions()[path];
    if (known !== undefined && inStep(path, text)) {
      stuck.delete(path);
      return true;
    }

    const reply = await send("POST", "save", { body: known === undefined ? { path, text } : { path, text, base: known } });
    if (!reply) {
      dirty.add(path);
      return false;
    }
    if (reply.status === 200) {
      if (reply.json.result === "saved") {
        mark(path, reply.json.version, text);
        await save();
        return true;
      }
      return takeMerge(path, text);
    }
    if (reply.status === 409) {
      const current = (await readIf(path)) ?? text; // typing may have gone on while the call was open
      const latest = reply.json.latest as { version: number; text: string };
      // The same text on both sides is not a clash, whatever Nexus said (a note made here that Nexus already holds, word for word).
      if (latest.text === current) mark(path, latest.version, latest.text);
      else await keepBoth(await openDisk(), path, current, latest);
      await save();
      return true;
    }
    stick(path, reply.status === 403 ? notAllowed(path) : wouldNotTake(path, reply.json.error));
    return true;
  }

  /** pushOne for one note among others: what goes wrong with this note (the vault would not read or write it) is reported and the others still go. */
  async function pushNote(path: string): Promise<boolean> {
    try {
      return await pushOne(path);
    } catch (error) {
      if (error instanceof Disconnected) throw error;
      if (error instanceof Refused) {
        stick(path, error.message, true); // Nexus would not hand the merged note over: it was put back in the dirty set and goes again next sync
        return true;
      }
      console.error("Nexus plugin:", error);
      stick(path, `Could not update ${nameOf(path)} (${reasonOf(error)}), so it was skipped.`, true);
      return true;
    }
  }

  /** Nexus merged the edit into what changed meanwhile. A save's answer has no text, so the note is read to get it. */
  async function takeMerge(path: string, sent: string): Promise<boolean> {
    let merged;
    try {
      merged = await fetchNote(path);
    } catch (error) {
      dirty.add(path); // Nexus has the merge but the note was not brought up to date: it is looked at again
      throw error;
    }
    if (!merged) {
      dirty.add(path);
      return true;
    }
    if ((await readIf(path)) === sent) {
      if (merged.text !== sent) await vault.write(path, merged.text);
      mark(path, merged.version, merged.text);
    } else {
      // Typing went on while the call was open. The note is left as it is; the next push builds on the stored version.
      dirty.add(path);
    }
    await save();
    return true;
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

  /** Looks at every note for one that is new or changed since it last matched Nexus (an edit made while Obsidian was closed). */
  async function scan(): Promise<void> {
    const disk = await openDisk();
    for (const path of disk.notes()) {
      if (dirty.has(path)) continue;
      if (!inStep(path, await disk.read(path))) dirty.add(path);
    }
    scanned = true;
  }

  // ── deletes ────────────────────────────────────────────────────────────────

  function queueDelete(path: string): void {
    const queue = (data.pendingDeletes ??= []);
    if (!queue.includes(path)) queue.push(path);
  }

  /** Tells Nexus about every note deleted here that it has not been told about yet. False when Nexus could not be reached. */
  async function flushDeletes(): Promise<boolean> {
    const queue = data.pendingDeletes ?? [];
    if (queue.length === 0) return true;
    const files = new Set(await vault.files());
    for (let at = 0; at < queue.length; at++) {
      const path = queue[at];
      // A note that is back (made again, or renamed back) is no longer a delete.
      if (!files.has(path) && versions()[path] === undefined) {
        const reply = await send("POST", "delete", { body: { path } });
        if (!reply) {
          data.pendingDeletes = queue.slice(at);
          await save();
          return false;
        }
        // 200 or 404: Nexus has no live note there now. A refusal can never go through, so it is not tried again.
        if (reply.status === 403) deps.notify(`Not allowed. Nexus does not let this device delete ${path}, so it stays there.`);
      }
    }
    data.pendingDeletes = [];
    await save();
    return true;
  }

  /** The vault lost this note (deleted, or renamed out of the notes): tell Nexus, or keep the delete until it can be told. */
  async function forget(path: string): Promise<boolean> {
    if (versions()[path] === undefined) return true; // never reached Nexus, or this plugin's own removal
    untrack(path);
    queueDelete(path);
    await save();
    return flushDeletes();
  }

  // ── coming down ────────────────────────────────────────────────────────────

  /** The text and version a standing note has, read from Nexus when the change carried no text. */
  async function textOf(path: string, standing: Extract<Standing, { live: true }>): Promise<{ version: number; text: string } | null> {
    if (standing.text !== undefined) return { version: standing.version, text: standing.text };
    return fetchNote(path);
  }

  /** A note that moved is renamed here too when its old file matches Nexus and the new name is free. */
  async function renameLocal(disk: Disk, to: string, standing: Extract<Standing, { live: true }>): Promise<boolean> {
    const from = standing.from;
    const known = versions()[to];
    if (from === undefined || (known !== undefined && standing.version <= known)) return false;
    if (versions()[from] === undefined || !disk.has(from) || disk.has(to)) return false;
    const hash = hashes()[from];
    if (hash === undefined || hash !== fingerprint(await disk.read(from))) return false;
    // Saved as well as moved: the new text has to come down too, which the plain write below does.
    if (standing.text !== undefined && fingerprint(standing.text) !== hash) return false;
    await disk.rename(from, to);
    untrack(from);
    versions()[to] = standing.version;
    hashes()[to] = hash;
    return true;
  }

  /** A note that stands in Nexus: written here when it is new or unchanged here; kept for the push when it has edits Nexus has not seen. */
  async function applyLive(disk: Disk, path: string, standing: Extract<Standing, { live: true }>): Promise<void> {
    const known = versions()[path];
    const fresh = standing.fresh === true;
    // Seen already, or this plugin's own save coming back. A fresh note is another note at the path, whose versions start
    // again, so its number says nothing about whether it was seen: its text does (below).
    if (!fresh && known !== undefined && standing.version <= known) return;
    const remote = await textOf(path, standing);
    if (!remote || (!fresh && known !== undefined && remote.version <= known)) return;
    if (fresh && known !== undefined && hashes()[path] === fingerprint(remote.text)) {
      versions()[path] = remote.version; // the text this plugin has stored: its own note, coming back in the feed
      return;
    }
    if (!disk.has(path)) {
      await disk.write(path, remote.text);
      mark(path, remote.version, remote.text);
      return;
    }
    const local = await disk.read(path);
    if (local === remote.text || inStep(path, local)) {
      if (local !== remote.text) await disk.write(path, remote.text);
      mark(path, remote.version, remote.text);
      return;
    }
    // Edits Nexus has not seen (or a note made here at a path Nexus holds). It goes up as it is with its old base and
    // Nexus merges, or keeps both. Nothing is overwritten here. A stored version that belonged to the note that moved
    // away is no base for the new note at this path: the edit goes up with none, and Nexus keeps both as a clash.
    if (fresh && known !== undefined) untrack(path);
    dirty.add(path);
  }

  /**
   * A note Nexus no longer has: removed here when it matches what Nexus last had; kept, and sent as a new note, when it has edits.
   * Only called when Nexus said so: a delete version in the feed, or a 404 for the note. A refused or failed read never gets here.
   */
  async function applyGone(disk: Disk, path: string): Promise<void> {
    if (versions()[path] === undefined) return; // not a note this plugin has in step: nothing to remove
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
   * the system refuses), or that Nexus would not hand over (a refusal such as 403), is reported by name and put on the list
   * to be tried again on the next sync, so it never stops the notes after it or the pulls after that, and the note is left
   * as it is. A lost connection still stops the pull: the cursor must not move past notes that were never looked at.
   */
  async function skipping(path: string, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (error instanceof Disconnected) throw error;
      if (error instanceof Refused) {
        stick(path, error.message, true);
      } else {
        console.error("Nexus plugin:", error);
        stick(path, `Could not update ${nameOf(path)} here (${reasonOf(error)}). ${TRIED_AGAIN}`, true);
      }
      const waiting = (data.pendingPulls ??= []);
      if (!waiting.includes(path)) waiting.push(path);
      return false;
    }
  }

  /** Tries again each note the vault could not write on an earlier sync, with the text Nexus has for it now. */
  async function retryPulls(): Promise<void> {
    const waiting = [...(data.pendingPulls ?? [])];
    if (waiting.length === 0) return;
    const disk = await openDisk();
    for (const path of waiting) {
      const done = await skipping(path, async () => {
        const remote = await fetchNote(path);
        if (remote) await applyLive(disk, path, { live: true, version: remote.version, text: remote.text });
        else await applyGone(disk, path); // a 404: Nexus no longer has it, so nothing comes down, and a removal that failed is tried again (any other answer threw, and the note stayed)
      });
      if (done) {
        data.pendingPulls = (data.pendingPulls ?? []).filter((waitingPath) => waitingPath !== path);
        stuck.delete(path);
      }
    }
    await save();
  }

  async function applyStanding(standing: Map<string, Standing>): Promise<void> {
    const disk = await openDisk();
    const handled = new Set<string>();
    for (const [path, now] of standing) {
      if (!now.live || now.from === undefined) continue;
      await skipping(path, async () => {
        if (await renameLocal(disk, path, now)) handled.add(path);
      });
    }
    for (const [path, now] of standing) {
      if (now.live && !handled.has(path)) await skipping(path, () => applyLive(disk, path, now));
    }
    for (const [path, now] of standing) {
      if (!now.live) await skipping(path, () => applyGone(disk, path));
    }
  }

  async function pull(cursor: string): Promise<boolean> {
    const feed = await readFeed(cursor);
    if (!feed) return false;
    await applyStanding(feed.standing);
    const moved = data.cursor !== feed.next;
    data.cursor = feed.next;
    if (moved || feed.standing.size > 0) await save();
    return true;
  }

  // ── the first sync ─────────────────────────────────────────────────────────

  /**
   * Brings a vault that has never synced together with Nexus, and deletes nothing. A note only in Nexus comes down,
   * a note only in the vault goes up, the same text on both sides is left alone, and different text is a clash.
   */
  async function firstSync(): Promise<boolean> {
    const feed = await readFeed("0");
    if (!feed) return false;
    const disk = await openDisk();
    const inNexus = new Set<string>();
    for (const [path, now] of feed.standing) {
      if (!now.live) continue; // deleted in Nexus: a note still in the vault is not removed, and goes up again below
      inNexus.add(path);
      await skipping(path, async () => {
        const remote = await textOf(path, now);
        if (!remote) return;
        if (!disk.has(path)) {
          await disk.write(path, remote.text);
          mark(path, remote.version, remote.text);
          return;
        }
        const local = await disk.read(path);
        if (local === remote.text) mark(path, remote.version, remote.text);
        else await keepBoth(disk, path, local, remote);
      });
    }
    for (const path of disk.notes()) if (!inNexus.has(path) && !dirty.has(path)) dirty.add(path);
    data.cursor = feed.next;
    scanned = true;
    await save();
    return pushDirty();
  }

  // ── the engine ─────────────────────────────────────────────────────────────

  async function runSync(): Promise<boolean> {
    if (!ready()) {
      scanned = false; // edits may have gone unseen while signed out: the first sync after signing in looks at every note again
      return false;
    }
    if (!(await flushDeletes())) return false;
    if (data.cursor === null) return firstSync();
    await retryPulls();
    if (!(await pull(data.cursor))) return false;
    if (!scanned) await scan();
    return pushDirty();
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
        // A vault that has never synced is brought together by its first sync, not by single edits.
        if (data.cursor === null) return;
        void exclusive(() => pass(() => pushNote(path)));
      }, EDIT_PAUSE_MS),
    );
  }

  function dropEdit(path: string): void {
    const waiting = editTimers.get(path);
    if (waiting !== undefined) clearTimeout(waiting);
    editTimers.delete(path);
    dirty.delete(path);
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
          const known = versions()[from];
          if (known === undefined) {
            // Never reached Nexus, or the echo of a rename this plugin made itself (its target is already known).
            if (versions()[to] === undefined) edited(to);
            return true;
          }
          const hash = hashes()[from];
          const reply = await send("POST", "move", { body: { from, to } });
          if (!reply) {
            // Could not be told now: the old name is deleted later and the new name goes up as a note.
            untrack(from);
            queueDelete(from);
            dirty.add(to);
            await save();
            return false;
          }
          if (reply.status === 200) {
            untrack(from);
            // The move's version follows the one stored only when nobody saved the note in between. A gap means another
            // device's edit landed first: it is not claimed as seen, so the next pull brings it down, and an edit made
            // here meanwhile is sent on the version stored, which Nexus merges.
            versions()[to] = reply.json.version === known + 1 ? reply.json.version : known;
            if (hash !== undefined) hashes()[to] = hash;
            await save();
            // The note may have been edited just before it was renamed, within the pause before that edit would have gone up.
            return pushNote(to);
          }
          untrack(from);
          if (reply.status === 404) {
            await save();
            return pushNote(to); // Nexus has no such note any more: the new name is a new note
          }
          if (reply.status === 409) {
            // Another note already holds the new name in Nexus: the old one goes, and this one meets it as a clash.
            queueDelete(from);
            await save();
            if (!(await flushDeletes())) {
              dirty.add(to);
              return false;
            }
            return pushNote(to);
          }
          stick(to, notAllowed(to));
          await save();
          return true;
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
      return sync();
    },

    status,
  };
}
