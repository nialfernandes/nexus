// Every setting the job reads, in one place, so the job, its README and its example Worker configuration all say the same thing. They
// come from the environment of the command, or from the bindings and secrets of the Worker: the same names in both.

import { MENTIONS_FOLDER } from "./titles";

/** The settings of the job itself. */
export const SETTING = {
  /** The folders whose notes are read, one or more, as a comma-separated list: `Transcripts/` is an example. */
  folders: "LINKER_FOLDERS",
  /** The most notes a run takes on. */
  maxNotes: "LINKER_MAX_NOTES",
  /** The most already-edited notes (a version after the first) a run reads to see whether they were linked. */
  maxChecks: "LINKER_MAX_CHECKS",
  /** The path of the note the job keeps its record of failed notes in, such as `Linker/State.md`. It is never in `Mentions/` or in a hidden folder. */
  stateNote: "LINKER_STATE_NOTE",
  /** How many times a note may fail before it is skipped, until its line is removed from the state note. */
  maxFailures: "LINKER_MAX_FAILURES",
  /** The address of the chat endpoint, such as `https://models.example.org/v1`. */
  modelAddress: "LINKER_MODEL_ADDRESS",
  /** The key the endpoint is given as a bearer token. */
  modelKey: "LINKER_MODEL_KEY",
  /** The model's name, as the endpoint knows it. There is no default. */
  modelName: "LINKER_MODEL_NAME",
  /** The most characters of transcript sent in one call. */
  modelWindow: "LINKER_MODEL_WINDOW_CHARS",
  /** How long one call may take, in seconds. */
  modelTimeout: "LINKER_MODEL_TIMEOUT_SECONDS",
} as const;

/** The settings of the vault the job reads and writes through @nexus/agent: the agent's address, token, key and approval. */
export const VAULT_SETTING = {
  address: "NEXUS_ADDRESS",
  token: "NEXUS_TOKEN",
  privateKey: "NEXUS_AGENT_PRIVATE_KEY",
  approval: "NEXUS_AGENT_APPROVAL",
} as const;

export const DEFAULT_MAX_NOTES = 10;
export const DEFAULT_MAX_CHECKS = 20;
export const DEFAULT_STATE_NOTE = "Linker/State.md";
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_CHARS = 12_000;
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** A window smaller than this is a mistake: a part would hold little more than a paragraph. */
const WINDOW_MIN = 500;

export interface LinkerSettings {
  /** Each ends in a slash. */
  folders: string[];
  maxNotes: number;
  maxChecks: number;
  /** The path of the job's own note of the notes it could not link. */
  stateNote: string;
  /** A note that has failed this many times is skipped until its line is removed from the state note. */
  maxFailures: number;
  model: { address: string; key: string; name: string; windowChars: number; timeoutMs: number };
}

/** Said when a setting is missing or is not what it should be. The message names the setting and never what it was set to, which may be a key. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export type Environment = Readonly<Record<string, unknown>>;

/** The setting's value as text, or undefined when it is not set or is blank. */
function text(env: Environment, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A whole number from `min`, from the setting or `fallback`. */
function whole(env: Environment, name: string, fallback: number, min: number): number {
  const value = text(env, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min) throw new SettingsError(`${name} has to be a whole number, ${min} or more.`);
  return number;
}

/** The folders as paths that end in a slash. A folder that is Mentions/ itself, or climbs out, is refused: the job never reads its own notes as transcripts. */
export function foldersOf(value: string): string[] {
  const folders = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (folders.length === 0) throw new SettingsError(`${SETTING.folders} names no folder.`);
  return folders.map((folder) => {
    const path = folder.endsWith("/") ? folder : `${folder}/`;
    if (path.startsWith("/") || path.startsWith(".") || /(^|\/)\.\.?(\/|$)|\\|\/\//.test(path)) throw new SettingsError(`${SETTING.folders} has a folder that is not a path inside the vault.`);
    if (path.startsWith(MENTIONS_FOLDER) || MENTIONS_FOLDER.startsWith(path)) throw new SettingsError(`${SETTING.folders} cannot hold ${MENTIONS_FOLDER}, where the job writes its own notes.`);
    return path;
  });
}

/**
 * The environment of a Worker with the model's key as a string. A Worker's secret is a string, or it is a Cloudflare Secrets Store binding:
 * an object whose `get()` answers the string. Both are taken, and nothing else is changed. A binding that cannot be read is a
 * `SettingsError` that names the setting and says nothing of what the store answered.
 */
export async function withModelKeyRead(env: Environment): Promise<Environment> {
  const binding = env[SETTING.modelKey];
  if (typeof binding !== "object" || binding === null || typeof (binding as { get?: unknown }).get !== "function") return env;
  try {
    return { ...env, [SETTING.modelKey]: await (binding as { get(): Promise<unknown> }).get() };
  } catch {
    throw new SettingsError(`${SETTING.modelKey} is a Secrets Store binding that could not be read.`);
  }
}

/** The path of the state note: a markdown note in a folder of its own, not in `Mentions/` and not in a hidden folder, which the plugin does not sync. */
export function stateNoteOf(value: string): string {
  const steps = value.split("/");
  const bad = !value.endsWith(".md") || !value.includes("/") || value.includes("\\") || steps.some((step) => step === "" || step.startsWith("."));
  if (bad) throw new SettingsError(`${SETTING.stateNote} has to be a path of a note in a folder, such as ${DEFAULT_STATE_NOTE}, and not in a hidden folder.`);
  if (value.startsWith(MENTIONS_FOLDER)) throw new SettingsError(`${SETTING.stateNote} cannot be in ${MENTIONS_FOLDER}, where the job writes its notes of what is mentioned.`);
  return value;
}

/** The job's settings from the environment, or a `SettingsError` that names every setting that is missing. */
export function readSettings(env: Environment): LinkerSettings {
  const required = [SETTING.folders, SETTING.modelAddress, SETTING.modelKey, SETTING.modelName] as const;
  const missing = required.filter((name) => text(env, name) === undefined);
  if (missing.length > 0) throw new SettingsError(`Set ${missing.join(", ")} first (see the package's README).`);
  const address = text(env, SETTING.modelAddress)!;
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not a web address");
  } catch {
    throw new SettingsError(`${SETTING.modelAddress} has to be a web address, such as https://models.example.org/v1.`);
  }
  return {
    folders: foldersOf(text(env, SETTING.folders)!),
    maxNotes: whole(env, SETTING.maxNotes, DEFAULT_MAX_NOTES, 1),
    maxChecks: whole(env, SETTING.maxChecks, DEFAULT_MAX_CHECKS, 0),
    stateNote: stateNoteOf(text(env, SETTING.stateNote) ?? DEFAULT_STATE_NOTE),
    maxFailures: whole(env, SETTING.maxFailures, DEFAULT_MAX_FAILURES, 1),
    model: {
      address,
      key: text(env, SETTING.modelKey)!,
      name: text(env, SETTING.modelName)!,
      windowChars: whole(env, SETTING.modelWindow, DEFAULT_WINDOW_CHARS, WINDOW_MIN),
      timeoutMs: whole(env, SETTING.modelTimeout, DEFAULT_TIMEOUT_SECONDS, 1) * 1000,
    },
  };
}

/** The vault settings, or a `SettingsError` that names every one that is missing. */
export function readVaultSettings(env: Environment): { address: string; token: string; privateKey: string; approval: string } {
  const names = Object.values(VAULT_SETTING);
  const missing = names.filter((name) => text(env, name) === undefined);
  if (missing.length > 0) throw new SettingsError(`Set ${missing.join(", ")} first (see the package's README).`);
  return {
    address: text(env, VAULT_SETTING.address)!,
    token: text(env, VAULT_SETTING.token)!,
    privateKey: text(env, VAULT_SETTING.privateKey)!,
    approval: text(env, VAULT_SETTING.approval)!,
  };
}
