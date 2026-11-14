// What the plugin keeps, and where. The plugin's data file (`data.json`) sits inside the vault, so anything that syncs
// the vault between devices (iCloud) syncs it too. Only the Nexus address and the user name, which are the same for every
// device, may live there. Neither has a default: a plugin that has never been set up has neither, and does nothing until it has both. The token, the device's id and name, the changes cursor and what is known of every note belong to one device: they
// are kept in Obsidian's per-device local storage (`app.saveLocalStorage`), so a vault shared between a Mac and an iPhone
// never shares them. These are plain functions so a test can call them without Obsidian.

import { encodeBase64Url } from "./base64";
import type { KnownNote, PendingDelete, PluginData } from "./types";

/** The key the per-device state is kept under in Obsidian's local storage for this vault. */
export const STATE_KEY = "nexus-state";

/** What the status line and a sign-in say while the address or the user name is missing. */
export const NOT_SET_UP = "Not set up yet. Open the Nexus settings and enter the server address and your user name.";

/** What goes in the data file. */
export interface SharedState {
  address: string;
  user: string;
}

/** True once the person has entered both the Nexus address and the user name. Until then the plugin sends nothing to anyone. */
export const isSetUp = (data: Pick<PluginData, "address" | "user">): boolean => data.address.trim() !== "" && data.user.trim() !== "";

/** What goes in this device's local storage. */
export interface DeviceState {
  token: string | null;
  cursor: string | null;
  notes: Record<string, KnownNote>;
  pendingDeletes: PendingDelete[];
  pendingPulls: string[];
  deviceName?: string;
  deviceId: string;
}

/** A random id for a note, made the first time the note is synced: 16 random bytes in url-safe base64, 22 characters. It says nothing about the note. */
export function newNoteId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A random id for this device, made once: 16 hex characters. */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function splitState(state: PluginData): { shared: SharedState; device: DeviceState } {
  return {
    shared: { address: state.address, user: state.user },
    device: {
      token: state.token,
      cursor: state.cursor,
      notes: state.notes,
      pendingDeletes: state.pendingDeletes ?? [],
      pendingPulls: state.pendingPulls ?? [],
      ...(state.deviceName !== undefined ? { deviceName: state.deviceName } : {}),
      deviceId: state.deviceId ?? "",
    },
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const pathList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : []);

/** What was kept of each note: an entry that is not whole is left out, and that note is met again as a new one. */
const knownNotes = (value: unknown): Record<string, KnownNote> => {
  const found: Record<string, KnownNote> = {};
  for (const [path, entry] of Object.entries(record(value) ?? {})) {
    const note = record(entry);
    if (
      typeof note?.id === "string" && note.id !== "" &&
      typeof note.version === "number" && Number.isInteger(note.version) && note.version >= 0 &&
      typeof note.hash === "string" &&
      typeof note.savedPath === "string"
    ) {
      found[path] = { id: note.id, version: note.version, hash: note.hash, savedPath: note.savedPath };
    }
  }
  return found;
};

const deleteList = (value: unknown): PendingDelete[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    if (typeof item?.id !== "string" || item.id === "" || typeof item.version !== "number") return [];
    return [{
      id: item.id,
      version: item.version,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.hash === "string" ? { hash: item.hash } : {}),
    }];
  });
};

/**
 * Puts what the two places hold back together. Only the address and the user name are taken from the data file: a token or a version left
 * there by anything else is not trusted, because a synced vault would have carried it from another device. A device with
 * nothing stored is signed out and has never synced, and is given an id of its own.
 *
 * A device that kept its notes by path and version, as the plugin did before notes were encrypted (no `notes` in what it stored),
 * has nothing that fits the server as it is now: its cursor and versions belong to a feed of plain text. It starts over, as a
 * device that has never synced, and the first sync (which deletes nothing) brings the vault and Nexus together.
 */
export function joinState(sharedRaw: unknown, deviceRaw: unknown, makeId: () => string = newDeviceId): PluginData {
  const shared = record(sharedRaw);
  const device = record(deviceRaw);
  const address = typeof shared?.address === "string" ? shared.address.trim() : "";
  const user = typeof shared?.user === "string" ? shared.user.trim() : "";
  const current = record(device?.notes) !== null;
  const id = typeof device?.deviceId === "string" && device.deviceId !== "" ? device.deviceId : makeId();
  return {
    address,
    user,
    token: typeof device?.token === "string" && device.token !== "" ? device.token : null,
    cursor: current && typeof device?.cursor === "string" ? device.cursor : null,
    notes: knownNotes(device?.notes),
    pendingDeletes: deleteList(device?.pendingDeletes),
    pendingPulls: current ? pathList(device?.pendingPulls) : [],
    ...(typeof device?.deviceName === "string" ? { deviceName: device.deviceName } : {}),
    deviceId: id,
  };
}

/** True when the data file holds anything but the address and the user name, so it is rewritten without it. */
export function sharedHasMore(sharedRaw: unknown): boolean {
  const shared = record(sharedRaw);
  return shared !== null && Object.keys(shared).some((key) => key !== "address" && key !== "user");
}

/**
 * The name a sign-in carries to Nexus, shown in its list of signed-in devices: the name the person typed, or the platform's name
 * with the first characters of the device's id, so two phones that are both "iPhone" can be told apart when one is revoked.
 */
export function signInLabel(chosen: string | undefined, platform: string, deviceId: string): string {
  const typed = chosen?.trim();
  return typed ? typed : `${platform} ${deviceId.slice(0, 4)}`;
}
