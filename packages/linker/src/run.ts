// One pass of the job. For each transcript note not yet linked: read it, find what it mentions (the links in its show notes, and
// what the model hears in its transcript), make sure each thing has its one note in Mentions/, and then, last, give the transcript note
// its `## Mentions` section and `mentions: linked`, saved at the version that was read.
//
// WHAT IT NEVER DOES. It never deletes a note. It changes a note outside Mentions/ only by adding the section and the one front matter
// line, and only when the note is still at the version it read, so a note edited meanwhile is left alone and tried again next run. The one
// other note it writes is its own state note (state.ts).
// A model that fails or answers with garbage leaves the note as it was, with the reason logged once and the failure written in the state
// note, because the transcript note cannot say it. At most `maxNotes` notes are taken on: the notes never tried first, then the ones that
// failed, the longest ago tried first, so notes that cannot be read never keep a new note from being linked. A note that has failed
// `maxFailures` times is not taken on until its line is taken out of the state note.

import type { Mention } from "./mention";
import { mentionsSpoken, ModelFailure, type ModelFetch } from "./model";
import { MentionNotes } from "./mentions";
import { isLinked, linkedText, ownLink, showNotesOf, spokenOf } from "./note-text";
import type { LinkerSettings } from "./settings";
import { mentionsInShowNotes } from "./show-notes";
import { StateNote, type Failure } from "./state";
import type { NoteRef, NoteStore } from "./store";
import { MENTIONS_FOLDER, titleKey } from "./titles";

export interface RunOptions {
  store: NoteStore;
  settings: LinkerSettings;
  /** How the model is asked. The runtime's `fetch` is what the job and the Worker give. */
  fetchModel: ModelFetch;
  /** Where a line of what happened goes. A failure's reason is given once, with the note's path. */
  log: (line: string) => void;
  /** What time it is, for the time a failure is written with. The clock's own when left out. */
  now?: () => Date;
}

export interface RunReport {
  /** The paths of the notes that were linked. */
  linked: string[];
  /** The notes that could not be done, each with the reason. They are written in the state note, and tried again by a later run until they have failed too often. */
  failed: Array<{ path: string; reason: string }>;
  /** The notes that were edited between being read and being saved, left alone and tried again next run. */
  changedMeanwhile: string[];
  /** The notes the run took on, linked or not. */
  tried: number;
}

/** The most things one note is linked to. A note that mentions more than this (a transcript that talks a model into a long list, show notes of hundreds of links) is linked to the first of them. */
export const MENTIONS_MAX = 100;

const inFolders = (path: string, folders: readonly string[]): boolean =>
  path.endsWith(".md") && !path.startsWith(MENTIONS_FOLDER) && folders.some((folder) => path.startsWith(folder));

/**
 * The notes to look at, in order. A note at its first version has never been written by this job (every save of ours makes a later
 * version), so it is known to be unlinked without being read. A note at a later version may be one this job linked, or one a person edited
 * first: they are read, newest by path first, and only as many as `maxChecks` allows.
 * Those come first when the job has never tried them. Then come the notes it tried and could not link (`failures`, by note id), the longest
 * ago tried first; a note that has failed `maxFailures` times is left out.
 */
export function notesToLookAt(
  refs: readonly NoteRef[],
  folders: readonly string[],
  failures: ReadonlyMap<string, Failure> = new Map(),
  maxFailures = Number.POSITIVE_INFINITY,
): NoteRef[] {
  const mine = refs.filter((ref) => inFolders(ref.path, folders));
  const byPath = (a: NoteRef, b: NoteRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const untried = mine.filter((ref) => !failures.has(ref.id));
  const fresh = untried.filter((ref) => ref.version === 1).sort(byPath);
  const later = untried.filter((ref) => ref.version > 1).sort(byPath).reverse();
  // Notes tried at the same moment stay in the order of the lines of the state note, and a time that is not one (a line a person wrote by
  // hand) is the longest ago.
  const byId = new Map(mine.map((ref) => [ref.id, ref] as const));
  const failed = [...failures.values()]
    .filter((failure) => failure.tries < maxFailures && byId.has(failure.id))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
    .map((failure) => byId.get(failure.id)!);
  return [...fresh, ...later, ...failed];
}

/** The mentions of a note, the same thing found twice (by a link and by the model) kept once, the first one found taking the details the second has and the first lacks. */
export function joined(lists: readonly Mention[][]): Mention[] {
  const byKey = new Map<string, Mention>();
  for (const mention of lists.flat()) {
    const key = titleKey(mention.title) || mention.title;
    const had = byKey.get(key);
    if (had === undefined) byKey.set(key, { ...mention });
    else {
      if (had.author === undefined && mention.author !== undefined) had.author = mention.author;
      if (had.url === undefined && mention.url !== undefined) had.url = mention.url;
    }
  }
  return [...byKey.values()];
}

export async function runLinker(options: RunOptions): Promise<RunReport> {
  const { store, settings, fetchModel, log } = options;
  const report: RunReport = { linked: [], failed: [], changedMeanwhile: [], tried: 0 };
  const now = options.now ?? (() => new Date());
  const refs = await store.listNotes();
  const notes = new MentionNotes(store, refs);
  const state = new StateNote(store, settings.stateNote);
  const failures = await loadFailures(state, refs, log);
  // The state note is never a transcript note, wherever the folders are.
  const candidates = refs.filter((ref) => ref.path !== settings.stateNote);
  for (const failure of failures.values()) {
    if (failure.tries >= settings.maxFailures) log(`${failure.path}: failed ${failure.tries} times, so it is skipped until its line is taken out of ${settings.stateNote} (${failure.reason})`);
  }
  let checked = 0;
  let reads = 0;

  for (const ref of notesToLookAt(candidates, settings.folders, failures, settings.maxFailures)) {
    if (report.tried >= settings.maxNotes) break;
    // A note that has failed before is one the job already knows: it is not one of the checks of notes it knows nothing about.
    const known = failures.has(ref.id);
    if (ref.version > 1 && !known && checked >= settings.maxChecks) continue;
    // However the notes turn out (unreadable, or linked already), a run reads no more than both limits allow between them.
    if (reads >= settings.maxNotes + settings.maxChecks) break;
    if (ref.version > 1 && !known) checked++;
    reads++;

    let note;
    try {
      note = await store.readNote(ref.id);
    } catch (error) {
      const reason = reasonOf(error);
      log(`${ref.path}: could not be read, so it is left for a later run (${reason})`);
      await state.failed(ref, reason, now()).catch((stateError) => log(notWritten(ref.path, stateError)));
      continue;
    }
    if (isLinked(note.text)) {
      // Linked by someone else since it failed (another run, or a person): its line is no use any more.
      if (known) await state.cleared(ref.id).catch((stateError) => log(notWritten(ref.path, stateError)));
      continue;
    }

    report.tried++;
    try {
      const spoken = await mentionsSpoken(settings.model, fetchModel, spokenOf(note.text));
      const written = mentionsInShowNotes(showNotesOf(note.text), ownLink(note.text));
      const names: string[] = [];
      const found = joined([written, spoken]);
      if (found.length > MENTIONS_MAX) log(`${ref.path}: mentions ${found.length} things, so it is linked to the first ${MENTIONS_MAX}`);
      for (const mention of found.slice(0, MENTIONS_MAX)) {
        const name = await notes.settle(mention);
        if (name !== null && !names.includes(name)) names.push(name);
      }
      const saved = await store.updateNote(note.id, note.version, linkedText(note.text, names));
      if (saved.result === "saved") {
        report.linked.push(ref.path);
        if (known) await state.cleared(ref.id).catch((stateError) => log(notWritten(ref.path, stateError)));
        log(`${ref.path}: linked to ${names.length} ${names.length === 1 ? "thing" : "things"}`);
      } else {
        report.changedMeanwhile.push(ref.path);
        log(`${ref.path}: was edited while it was being linked, so it is left for the next run`);
      }
    } catch (error) {
      const reason = reasonOf(error);
      report.failed.push({ path: ref.path, reason });
      log(`${ref.path}: not linked, left for a later run (${reason})`);
      await state.failed(ref, reason, now()).catch((stateError) => log(notWritten(ref.path, stateError)));
    }
  }
  return report;
}

/** What the state note holds. A state note that cannot be read is logged and taken as empty: every note is tried as if it never failed, which is how the job was before it kept one. */
async function loadFailures(state: StateNote, refs: readonly NoteRef[], log: (line: string) => void): Promise<Map<string, Failure>> {
  try {
    return await state.load(refs);
  } catch (error) {
    log(`The state note could not be read, so every note is tried as if it had never failed (${reasonOf(error)})`);
    return new Map();
  }
}

const notWritten = (path: string, error: unknown): string => `${path}: its failure could not be written in the state note (${reasonOf(error)})`;

/** A failure in words that hold nothing secret: the model's and the vault's own messages are fixed sentences, anything else is only named by its kind. */
function reasonOf(error: unknown): string {
  if (error instanceof ModelFailure) return error.message;
  if (error instanceof Error && (error.name === "AgentError" || error.name === "StateError")) return error.message;
  return `an unexpected ${error instanceof Error ? error.name : "error"}`;
}

/** What a run did, as lines for a terminal or a Worker's log. */
export function summaryOf(report: RunReport): string[] {
  const count = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  const lines = [`Linked ${report.linked.length} of ${count(report.tried)} taken on.`];
  if (report.changedMeanwhile.length > 0) lines.push(`${count(report.changedMeanwhile.length)} edited meanwhile, left for the next run.`);
  if (report.failed.length > 0) lines.push(`${count(report.failed.length)} could not be linked, left for a later run.`);
  return lines;
}
