// The job's own record of the notes it could not link: one note of its own, in a folder of its own (`Linker/State.md` is the example).
// The job may write nothing into a transcript note but its Mentions section and its one front matter line, so a failure cannot be marked
// there. Here, each failed note has one line with the id Nexus knows it by, how many times it failed, when it was last tried, why, and its
// path (to read by; the id is what counts). A person clears a line by deleting it, and the note is tried again.
//
// Two runs at once do not lose a line: the note is made with a key (so both make the same note), and every change is read, made on what
// was read, and saved at the version read; a save that finds the note moved on reads it again and makes the change again.

import type { NoteStore } from "./store";

/** What the job knows of one failed note. */
export interface Failure {
  id: string;
  /** How many times it has failed. */
  tries: number;
  /** When it was last tried, as `Date.prototype.toISOString` writes it. */
  at: string;
  /** Why it failed last: one of the job's fixed sentences. */
  reason: string;
  path: string;
}

export const STATE_HEADING = "# Linker state";
const INTRODUCTION =
  "The linking job's record of transcript notes it could not link. Each line is one note: its id, how many times it has failed, when it was last tried, why, and its path. " +
  "A note that has failed too many times is skipped. Delete its line to have it tried again. The job writes this note and nothing else outside Mentions/.";

/** The line of one failure. The path is last, so it may hold anything; the reason cannot hold the separator. */
export function lineOf(failure: Failure): string {
  const one = (text: string) => text.replace(/\s+/g, " ").trim();
  return `- ${failure.id} | failed ${failure.tries} | ${failure.at} | ${one(failure.reason).replace(/\|/g, "/")} | ${one(failure.path)}`;
}

const LINE = /^- (\S+) \| failed (\d+) \| (\S+) \| (.*?) \| (.*)$/;

/** The failure on a line, or null for a line that is not one (a person's own words in the note are left alone). */
export function failureOf(line: string): Failure | null {
  const found = LINE.exec(line);
  if (found === null) return null;
  const tries = Number(found[2]);
  if (!Number.isSafeInteger(tries)) return null;
  return { id: found[1]!, tries, at: found[3]!, reason: found[4]!, path: found[5]! };
}

/** The failures a state note holds, by note id, in the order of its lines. A note's first line is the one that counts. */
export function failuresIn(text: string): Map<string, Failure> {
  const failures = new Map<string, Failure>();
  for (const line of text.split("\n")) {
    const failure = failureOf(line);
    if (failure !== null && !failures.has(failure.id)) failures.set(failure.id, failure);
  }
  return failures;
}

/** The text of a state note with nothing in it yet. */
export const EMPTY_STATE = `${STATE_HEADING}\n\n${INTRODUCTION}\n\n`;

/** The text with one more failure of the note: its line made, or its line's count raised by one, from what the text holds now. */
export function withFailure(text: string, note: { id: string; path: string }, reason: string, at: string): string {
  const lines = text.split("\n");
  const where = lines.findIndex((line) => failureOf(line)?.id === note.id);
  const before = where < 0 ? undefined : failureOf(lines[where]!);
  const line = lineOf({ id: note.id, tries: (before?.tries ?? 0) + 1, at, reason, path: note.path });
  if (where >= 0) {
    lines[where] = line;
    return lines.join("\n");
  }
  // A new line goes at the end, on a line of its own.
  return `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${line}\n`;
}

/** The text without the lines of the note. */
export function withoutFailure(text: string, id: string): string {
  return text
    .split("\n")
    .filter((line) => failureOf(line)?.id !== id)
    .join("\n");
}

/** How many times a change is made again when another run saved the note first. Each is a read and a save, and another run's saves are as many as it has failures. */
const SAVE_TRIES = 8;

/** Said when the state note could not be changed. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

/** The state note in the vault: reads what it holds, and changes it by the rules at the top of this file. */
export class StateNote {
  readonly #store: NoteStore;
  readonly #path: string;
  #id: string | undefined;

  constructor(store: NoteStore, path: string) {
    this.#store = store;
    this.#path = path;
  }

  /** The key the note is made with: the same path is the same note, in every run. */
  get #key(): string {
    return `linker state ${this.#path}`;
  }

  /** Takes the id of the note at the path from the notes there are. Undefined when there is none yet. */
  #find(refs: ReadonlyArray<{ id: string; path: string }>): void {
    this.#id = refs.find((ref) => ref.path === this.#path)?.id;
  }

  /** What the note holds now, by note id. Nothing is held when there is no note yet. `refs` is every note of the vault. */
  async load(refs: ReadonlyArray<{ id: string; path: string }>): Promise<Map<string, Failure>> {
    this.#find(refs);
    if (this.#id === undefined) return new Map();
    return failuresIn((await this.#store.readNote(this.#id)).text);
  }

  /** Records one more failure of the note. */
  failed(note: { id: string; path: string }, reason: string, at: Date): Promise<void> {
    return this.#change((text) => withFailure(text, note, reason, at.toISOString()));
  }

  /** Takes the note's line out, when it has one. */
  cleared(id: string): Promise<void> {
    return this.#change((text) => withoutFailure(text, id));
  }

  /** Makes `change` to the text as it is now, whoever else is changing it: read, change, save at the version read, and again if it moved on. */
  async #change(change: (text: string) => string): Promise<void> {
    for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
      if (this.#id === undefined) {
        try {
          this.#id = (await this.#store.createNote(this.#path, change(EMPTY_STATE), { key: this.#key })).id;
          return;
        } catch (error) {
          if (!(error instanceof Error) || (error as { code?: unknown }).code !== "key-taken") throw error;
          // Another run made it a moment ago, with other text: it is there now, so it is read and changed like any note.
          this.#find(await this.#store.listNotes());
          if (this.#id === undefined) throw error;
        }
      }
      const note = await this.#store.readNote(this.#id);
      const next = change(note.text);
      if (next === note.text) return;
      if ((await this.#store.updateNote(note.id, note.version, next)).result === "saved") return;
    }
    throw new StateError("The state note was changed by another run every time it was tried.");
  }
}
