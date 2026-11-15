// The four calls the job makes on the vault. @nexus/agent's `AgentVault` has all four, and every read and write the job makes goes
// through them: the job never deletes a note, and there is no call here that would.

/** One note without its text: where it is, the id Nexus knows it by, and the version it is at. */
export interface NoteRef {
  id: string;
  path: string;
  version: number;
}

/** One note with its text. */
export interface NoteContent extends NoteRef {
  text: string;
}

/** What saving the next version of a note did: it was saved, or the note had moved on and nothing was changed. */
export type SaveResult = { result: "saved"; version: number } | { result: "changed-since" };

export interface NoteStore {
  /** Every note in the vault, by path. */
  listNotes(): Promise<NoteRef[]>;
  /** One note, as it is now. */
  readNote(id: string): Promise<NoteContent>;
  /**
   * A new note at `path`. With a `key`, its id is made from the key and the vault key: the same key is always the same id, so a second call
   * with it makes no second note. It answers the note that is there when its path and text are the same, and is refused with the code
   * `key-taken` when they are not.
   */
  createNote(path: string, text: string, options?: { key: string }): Promise<NoteRef>;
  /** The next version of a note, only when it is still at `version`. */
  updateNote(id: string, version: number, text: string): Promise<SaveResult>;
}
