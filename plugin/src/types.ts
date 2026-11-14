// The shapes the plugin's pieces hand each other. The sync engine and the sign-in know nothing of Obsidian: they are
// given these few ports, and the plugin's entry (main.ts) wires Obsidian's own vault, `requestUrl` and `Notice` to them.
// That keeps both files free of anything that only runs inside Obsidian, so a test can load them on their own.

import type { SearchHit } from "./search";
import type { Unlock } from "./unlock";

/**
 * What the plugin keeps between runs. Only the address and the user name are saved in the vault's data file; the rest is
 * this device's own, in local storage (see state.ts).
 */
export interface PluginData {
  /** The Nexus address: the API's base, with no trailing slash. Empty until the person has entered it. */
  address: string;
  /** The user Nexus is asked to let this device in as: the name of a person or identity Nexus holds. Empty until the person has entered it. */
  user: string;
  /** The bearer token, or null when signed out. It is never shown anywhere. */
  token: string | null;
  /** Where the changes feed stood after the last pull, or null for a vault that has never synced. */
  cursor: string | null;
  /**
   * What this device knows of each note it has synced, by the note's path in this vault. The note's id is made here, at
   * random, the first time the note is synced, and stays with the note through every rename and move (a move changes
   * the path inside the encrypted record, never the id).
   */
  notes: Record<string, KnownNote>;
  /** Notes deleted here that Nexus has not been told about yet (offline or signed out at the time). */
  pendingDeletes?: PendingDelete[];
  /** The ids of notes Nexus has that this device could not take: the vault could not write them, or they did not open. Each is tried again on the next sync. */
  pendingPulls?: string[];
  /** The name this device is known by, in a sign-in and in the name of a clash copy. */
  deviceName?: string;
  /** Made once on this device: tells it apart from another of the same kind in Nexus's list of signed-in devices. */
  deviceId?: string;
}

/** One note this device has synced. */
export interface KnownNote {
  /** The note's id: random, base64url, made on the first sync of the note and never changed. */
  id: string;
  /** The version of the note this device last matched. 0 for a note whose id is made but whose first save has not been confirmed. */
  version: number;
  /** A fingerprint of the note's text as it was at that version, to tell an edit from no change. */
  hash: string;
  /** The path the note had in the encrypted record at that version: a note renamed here since is a note to send again. */
  savedPath: string;
}

/**
 * A note deleted here, and the version it was at, which is what Nexus needs to delete it. The path and the fingerprint of its text
 * are kept (on this device only) so that a note put back, with the same text, before the delete was sent is not deleted.
 */
export interface PendingDelete {
  id: string;
  version: number;
  path?: string;
  hash?: string;
}

export interface VaultPort {
  /** Every file in the vault, notes and attachments alike. The engine decides which are notes. */
  files(): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Makes the file and its folders, or overwrites it. */
  write(path: string, text: string): Promise<void>;
  /** Makes the target's folders. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Obsidian's `requestUrl`, narrowed to what the plugin uses. */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  throw?: boolean;
}

export interface HttpResponse {
  status: number;
  text: string;
  readonly json: any;
}

/** Rejects only when there is no network. */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export interface SyncDeps {
  vault: VaultPort;
  http: Http;
  /** Kept as the live object: the engine reads the token and the address from it every time and writes the rest into it. */
  data: PluginData;
  /** Saves the whole data. Awaited before the engine's method that changed it is done. */
  persist: (data: PluginData) => Promise<void>;
  /** Obsidian's `Notice`: one plain message per call. */
  notify: (message: string) => void;
  /** The device's name, as it is written in a clash copy's name. */
  device: string;
  now: () => Date;
  /** Where the vault's key comes from. While it holds none, the engine sends and reads nothing and the status line says the vault is locked. */
  unlock: Unlock;
  /** Called when the status line changed, so a screen showing it can show the new words. */
  onStatus?: () => void;
}

export interface SyncEngine {
  /** The first sync when the vault has never synced, otherwise a pull of every change after the cursor. */
  sync(): Promise<void>;
  /** Sends the note's current text now, with the stored version as base. */
  push(path: string): Promise<void>;
  /** A note was created or changed in the vault: it goes up after a pause in typing. Returns at once. */
  edited(path: string): void;
  renamed(from: string, to: string): Promise<void>;
  deleted(path: string): Promise<void>;
  /** Syncs now and again every SYNC_EVERY_MS. */
  start(): void;
  stop(): void;
  /** The app came back to the front. */
  cameToFront(): Promise<void>;
  /** The one line the settings tab and the status bar show. */
  status(): string;
  /** Searches the vault's notes on this device: nothing is asked of Nexus, which cannot read a note. */
  search(query: string, limit?: number): SearchHit[];
}

export interface SignInDeps {
  http: Http;
  data: PluginData;
  persist: (data: PluginData) => Promise<void>;
  device: string;
  /** Shows the person the link and the code. */
  show: (link: string, code: string) => void;
  /** Opens the link in a browser. */
  open: (link: string) => void;
  /** Pauses between polls. */
  wait: (ms: number) => Promise<void>;
}
