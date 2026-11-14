// The shapes the plugin's pieces hand each other. The sync engine and the sign-in know nothing of Obsidian: they are
// given these few ports, and the plugin's entry (main.ts) wires Obsidian's own vault, `requestUrl` and `Notice` to them.
// That keeps both files free of anything that only runs inside Obsidian, so a test can load them on their own.

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
  /** The Nexus version last seen for each note path. */
  versions: Record<string, number>;
  /** A fingerprint of each note's text as it was when it last matched Nexus, to tell an edit from no change. */
  hashes?: Record<string, string>;
  /** Notes deleted here that Nexus has not been told about yet (offline or signed out at the time). */
  pendingDeletes?: string[];
  /** Notes Nexus has that the vault could not write; each is tried again on the next sync. */
  pendingPulls?: string[];
  /** The name this device is known by, in a sign-in and in the name of a clash copy. */
  deviceName?: string;
  /** Made once on this device: tells it apart from another of the same kind in Nexus's list of signed-in devices. */
  deviceId?: string;
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
