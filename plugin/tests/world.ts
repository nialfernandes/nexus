// A world for the Nexus Obsidian plugin's tests: the real Nexus server held in this process (real-nexus.ts), a vault held in
// memory, and the plugin's sync engine and sign-in wired to both through the same few ports Obsidian will hand them.
//
// WHERE THINGS COME FROM
//   - Nexus is the server's own code (server/src), over an in-memory SQLite database. Every request the plugin makes goes
//     through `nexusOver` into it as a real `Request`, and the answer comes back as a real `Response`, so every answer the
//     plugin reads is the one the server sends: a save answers `{ result, id, version }` and nothing more, a save from a version the
//     note has moved past answers 409 with `current`, a note is read as `{ id, version, kind, kid, blob, ... }`, the changes feed
//     answers `{ changes, next }` with the blob of each save. What is the server's and what is not is written at the top of
//     real-nexus.ts.
//   - The plugin's token is never planted. It is got the way a device gets one in use: a sign-in is started, the owner's
//     session approves it, the device polls (`issueToken`).
//   - Notes another writer made are saved through the routes as the identity `agents` (a token got the same way), so a
//     version's writer, its number and its place in the feed are the server's own. The server holds blobs only, so the world
//     has the vault key (`world.keys`) and makes and opens blobs itself with @nexus/crypto, not through the plugin's own code:
//     `world.elsewhere` is another writer that encrypts, `nexusTexts` opens what Nexus holds, `sentNote` opens what a device sent.
//   - The vault is the one thing standing in for Obsidian: `FakeVault`. It refuses what Obsidian refuses: reading, renaming
//     or removing a file that is not there, and renaming onto a file that is.
//
// THE PORTS (the tests import the engine and the sign-in and hand them these; the types are the plugin's own, src/types.ts)
//   vault    Every path in `files()` is a file of the vault: notes, attachments and anything else alike. The engine alone
//            decides which are notes and never reads, writes, moves or removes any other.
//   http     Obsidian's `requestUrl`, narrowed to what the engine uses. The engine passes `throw: false` on every call, sends
//            a body with `contentType: "application/json"`, and puts the token in an `authorization: Bearer <token>`
//            header. The engine never calls `fetch`: `forbidFetch` makes `fetch` throw while a test runs.
//   data     What the plugin keeps between runs: the address, the user name, the token and the rest (see src/types.ts).
//   persist  Called with the whole data whenever something it keeps changed, and awaited. The tests read what the engine
//            knows from the last persisted data, so a restart is a new engine over a copy of it.
//   unlock   Where the vault key comes from (src/unlock.ts). A device in a test is unlocked with the world's key unless it is
//            given another, or none (a locked vault).
//   notify   Obsidian's `Notice`: one plain message per call.
//   device   The device's name, as it is written in a clash copy's name.
//   now      The clock.
//
// The events an engine's own vault writes cause (Obsidian tells the plugin about its own `write`, `rename` and `remove`
// too) are sent back to the engine by the tests as `edited`, `renamed` and `deleted`, and must not be sent to Nexus.

import { decryptNote, encryptNote, generateVaultKey } from "@nexus/crypto";
import { expect, vi } from "vitest";
import { fingerprint } from "../src/notes";
import { newNoteId } from "../src/state";
import type { Http, KnownNote, PluginData, SignInDeps, SyncDeps, SyncEngine, VaultPort } from "../src/types";
import type { VaultKeys } from "../src/unlock";
import { API, OWNER, ORIGIN, RealNexus, type Answer, type Who } from "./real-nexus";
import { TestUnlock } from "./test-unlock";

export type { Http, KnownNote, PluginData, SignInDeps, SyncDeps, SyncEngine, VaultKeys, VaultPort };
export { ORIGIN, OWNER, TestUnlock };

/** The vault the tests' notes belong to, and the number of its key. */
export const VAULT_ID = "test-vault";
export const KID = 1;

export const EDIT_PAUSE = 3_000;
export const SYNC_EVERY = 30_000;

// ── the plugin's modules ─────────────────────────────────────────────────────

export const loadSync = () => import("../src/sync");
export const loadSignIn = () => import("../src/sign-in");

// ── what happened, in order ──────────────────────────────────────────────────

export interface Seen {
  method: string;
  /** The route under the API's base: `save`, `note`, `changes`, `device/start` and so on. */
  route: string;
  query: Record<string, string>;
  /** The JSON the request carried, or undefined. */
  body: any;
  authorization: string | null;
  /** What the call said about `throw`. */
  throwFlag: boolean | undefined;
  contentType: string | null;
  status?: number;
  answer?: any;
}

export type Step =
  | { kind: "request"; seen: Seen }
  | { kind: "read" | "write" | "remove"; path: string; text?: string }
  | { kind: "rename"; path: string; to: string };

export interface Log {
  timeline: Step[];
  requests(): Seen[];
  /** The requests to one route, as `METHOD route`. */
  to(call: string): Seen[];
  /** What happened to the vault's files (reads left out). */
  changesToVault(): Step[];
  reads(): string[];
  /** How many calls are still waiting for Nexus to answer. */
  inFlight: number;
}

export function newLog(): Log {
  const timeline: Step[] = [];
  const log: Log = {
    timeline,
    requests: () => timeline.flatMap((s) => (s.kind === "request" ? [s.seen] : [])),
    to: (call) => log.requests().filter((s) => `${s.method} ${s.route}` === call),
    changesToVault: () => timeline.filter((s) => s.kind === "write" || s.kind === "rename" || s.kind === "remove"),
    reads: () => timeline.flatMap((s) => (s.kind === "read" ? [s.path] : [])),
    inFlight: 0,
  };
  return log;
}

// ── Nexus, the real server ───────────────────────────────────────────────────

/** The Nexus the tests of this file talk to: made by `openWorld`, its notes emptied by `emptyNexus`. */
let open: RealNexus | undefined;

function nexus(): RealNexus {
  if (!open) throw new Error("openWorld() has not been called: there is no Nexus to talk to.");
  return open;
}

export function nexusOver(log: Log, network: { online: boolean }): Http {
  return async (request) => {
    if (!network.online) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    const url = new URL(request.url);
    const base = new URL(ORIGIN + API);
    const route = url.pathname.startsWith(`${base.pathname}/`) ? url.pathname.slice(base.pathname.length + 1) : url.pathname;
    const headers = new Headers(request.headers ?? {});
    if (request.contentType) headers.set("content-type", request.contentType);
    let body: any;
    if (request.body !== undefined) {
      try {
        body = JSON.parse(request.body);
      } catch {
        body = request.body;
      }
    }
    const seen: Seen = {
      method: (request.method ?? "GET").toUpperCase(),
      route,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get("authorization"),
      throwFlag: request.throw,
      contentType: headers.get("content-type"),
    };
    log.timeline.push({ kind: "request", seen });
    log.inFlight++;
    try {
      const res = await nexus().fetch(new Request(request.url, { method: seen.method, headers, body: request.body, redirect: "manual" }));
      const text = await res.text();
      seen.status = res.status;
      try {
        seen.answer = JSON.parse(text);
      } catch {
        seen.answer = undefined;
      }
      return {
        status: res.status,
        text,
        get json() {
          return JSON.parse(text);
        },
      };
    } finally {
      log.inFlight--;
    }
  };
}

// ── Obsidian's vault, in memory ──────────────────────────────────────────────

export class FakeVault implements VaultPort {
  private readonly store = new Map<string, string>();
  log: Log;

  constructor(files: Record<string, string>, log: Log) {
    for (const [path, text] of Object.entries(files)) this.store.set(path, text);
    this.log = log;
  }

  async files(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async read(path: string): Promise<string> {
    this.log.timeline.push({ kind: "read", path });
    const text = this.store.get(path);
    if (text === undefined) throw new Error(`The file ${path} is not in the vault.`);
    return text;
  }

  async write(path: string, text: string): Promise<void> {
    this.log.timeline.push({ kind: "write", path, text });
    this.store.set(path, text);
  }

  async rename(from: string, to: string): Promise<void> {
    this.log.timeline.push({ kind: "rename", path: from, to });
    if (!this.store.has(from)) throw new Error(`The file ${from} is not in the vault.`);
    if (this.store.has(to)) throw new Error(`Destination file already exists: ${to}`);
    this.store.set(to, this.store.get(from)!);
    this.store.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.log.timeline.push({ kind: "remove", path });
    if (!this.store.delete(path)) throw new Error(`The file ${path} is not in the vault.`);
  }

  /** Every file and its text. */
  texts(): Record<string, string> {
    return Object.fromEntries([...this.store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  /** What the vault holds at `path`, or undefined. Not a read the plugin made, so it is not logged. */
  textOf(path: string): string | undefined {
    return this.store.get(path);
  }

  /** Changes a file the way a person typing would, with no engine involved. */
  type(path: string, text: string): void {
    this.store.set(path, text);
  }

  /** The paths of every file whose name starts with `prefix`. */
  pathsStarting(prefix: string): string[] {
    return [...this.store.keys()].filter((p) => p.startsWith(prefix)).sort();
  }
}

// ── answers ──────────────────────────────────────────────────────────────────

/** The body of an answer that must have `status`. A body that is not there fails here, on "expected 404 to be 200". */
export function bodyOf(answer: Answer, status = 200): any {
  expect(answer.status, `status of the answer (${answer.text.slice(0, 100)})`).toBe(status);
  return answer.body;
}

/** One raw request to the server's API, as `who`: for what the plugin must never call (a route the server no longer has). */
export const askNexus = (method: string, route: string, who: Who, body?: unknown): Promise<Answer> => nexus().send(method, `${API}/${route}`, who, body);

/** Every row of every table of the server's database, as text: what whoever runs the server could read. */
export const everythingStored = (): string => nexus().everythingStored();

/** The routes only the owner may call, as `who`. */
export const manage = (who: Who) => nexus().manage(who);

/** The device's calls, and the owner's answers to them. */
export const deviceRoutes = (who: Who = null) => nexus().device(who);

/** A token made the way a device gets one: start, the owner approves, the device polls. Every step must work. */
export async function issueToken(ownerCookie: string, identity: string, label: string): Promise<string> {
  const started = bodyOf(await deviceRoutes().start(identity, label));
  expect(typeof started.code, "start hands back a code").toBe("string");
  bodyOf(await deviceRoutes({ cookie: ownerCookie }).approve(started.code));
  const polled = bodyOf(await deviceRoutes().poll(started.secret));
  expect(polled.status, "the first poll after approval").toBe("approved");
  expect(typeof polled.token, "the first poll after approval hands over the token").toBe("string");
  return polled.token;
}

// ── blobs, made and opened here with @nexus/crypto, not through the plugin's own code ──────────────────────

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** A note's blob as the server takes it: the record encrypted under `keys`, written as base64. */
export async function blobFor(keys: VaultKeys, id: string, path: string, text: string): Promise<string> {
  return toBase64(await encryptNote(keys.vaultKey, { vaultId: keys.vaultId, noteId: id, kid: keys.kid }, { path, text }));
}

/** What a blob holds, or throws when it does not open under `keys` for this note id. */
export async function openBlob(keys: VaultKeys, id: string, blob: string): Promise<{ path: string; text: string }> {
  return decryptNote(keys.vaultKey, { vaultId: keys.vaultId, noteId: id, kid: keys.kid }, fromBase64(blob));
}

/** The base64 text of a blob with one byte changed: a blob the server has altered, or damaged on the way. */
export function tampered(blob: string): string {
  const bytes = fromBase64(blob);
  bytes[bytes.length - 1] ^= 1;
  return toBase64(bytes);
}

/** Another writer of the same vault: it holds the key, so what it saves is an encrypted note like any device's. */
export interface Elsewhere {
  /** Makes a note and saves it as its first version. Returns its id (made here unless given) and its version. */
  create(path: string, text: string, id?: string): Promise<{ id: string; version: number }>;
  /** Saves a new version of a note from the version it is at now, the way a device that has just pulled it would. Returns the version. */
  update(id: string, path: string, text: string): Promise<number>;
  /** Deletes a note from the version it is at now. */
  remove(id: string): Promise<void>;
}

function elsewhereOver(routes: ReturnType<RealNexus["vault"]>, keys: VaultKeys): Elsewhere {
  const headVersion = async (id: string): Promise<number> => bodyOf(await routes.note(id)).version;
  return {
    async create(path, text, id = newNoteId()) {
      const saved = bodyOf(await routes.save(id, await blobFor(keys, id, path, text), { base: 0, kid: keys.kid }));
      return { id, version: saved.version };
    },
    async update(id, path, text) {
      const base = await headVersion(id);
      return bodyOf(await routes.save(id, await blobFor(keys, id, path, text), { base, kid: keys.kid })).version;
    },
    async remove(id) {
      bodyOf(await routes.remove(id, await headVersion(id)));
    },
  };
}

// ── the world ────────────────────────────────────────────────────────────────

export interface World {
  /** The owner's session, as the cookie a browser signed in as the owner sends. */
  ownerCookie: string;
  /** The routes as the owner. */
  owner: ReturnType<RealNexus["vault"]>;
  /** The user the plugin signs in as: the name it is given in its settings. */
  user: string;
  /** A bearer token for the plugin as `user`. */
  token: string;
  /** The routes as the identity `agents`, as they are: ids and blobs. For another writer that encrypts, see `elsewhere`. */
  agents: ReturnType<RealNexus["vault"]>;
  /** The vault key, its vault id and its number: what every device of the world is unlocked with. */
  keys: VaultKeys;
  /** Another writer of the same vault (the identity `agents`) that makes and opens blobs with the world's key. */
  elsewhere: Elsewhere;
  address: string;
  /** A fresh token for `identity`, got through the device approval. */
  tokenFor(identity: string, label: string): Promise<string>;
  /** The routes as `who`. */
  as(who: Who): ReturnType<RealNexus["vault"]>;
}

/** Once per test file: a Nexus with its owner, the plugin's token and another writer's. */
export async function openWorld(): Promise<World> {
  open = await RealNexus.open();
  const { ownerCookie } = open;
  const tokenFor = (identity: string, label: string) => issueToken(ownerCookie, identity, label);
  const token = await tokenFor(OWNER, "the plugin under test");
  const agentsToken = await tokenFor("agents", "another writer");
  const keys: VaultKeys = { vaultKey: await generateVaultKey(), vaultId: VAULT_ID, kid: KID };
  const agents = open.vault({ bearer: agentsToken });
  return {
    ownerCookie,
    owner: open.vault({ cookie: ownerCookie }),
    user: OWNER,
    token,
    agents,
    keys,
    elsewhere: elsewhereOver(agents, keys),
    address: ORIGIN + API,
    tokenFor,
    as: (who) => nexus().vault(who),
  };
}

/** Before each test: no notes and no versions, so every test starts from a feed that begins at its own first change. */
export async function emptyNexus(): Promise<void> {
  nexus().emptyNotes();
}

// ── a device: a vault, its data and an engine over them ──────────────────────

export const DEVICE_NAME = "Test iPhone";
/** The clock every device runs: noon UTC, so its day is the same day in every time zone the tests run in. */
export const NOW = new Date(Date.UTC(2026, 10, 14, 12, 0, 0));

/** What a device knows of a note it last matched at `version` with `text`: for a test that starts a device partway through. */
export function known(path: string, text: string, version = 1, id: string = newNoteId()): KnownNote {
  return { id, version, hash: fingerprint(text), savedPath: path };
}

export interface DeviceOptions {
  /** The files the vault holds, when it is a new vault. */
  files?: Record<string, string>;
  /** The disk of an earlier run, to start the plugin again over it. */
  vault?: FakeVault;
  /** What the plugin had kept, to start again over it. */
  from?: PluginData;
  /** What the plugin already knows of each note, by path. */
  notes?: Record<string, KnownNote>;
  cursor?: string | null;
  /** Where the vault key comes from: the world's key by default, a TestUnlock to share one between restarts, or null for a locked vault. */
  unlock?: TestUnlock | null;
  /** Null for a plugin that is signed out. */
  token?: string | null;
  /** The server address the plugin was given; empty for one that was never set up. */
  address?: string;
  /** The user name the plugin was given; empty for one that was never set up. */
  user?: string;
  name?: string;
}

export interface Device {
  vault: FakeVault;
  engine: SyncEngine;
  log: Log;
  notices: string[];
  /** Every `persist` call, as a copy of the data at the moment of the call. */
  saved: PluginData[];
  network: { online: boolean };
  deps: SyncDeps;
  /** The port the engine is given for its key. Lock it, or unlock it, the way the setup screens will. */
  unlock: TestUnlock;
  /** What the plugin has kept: the last persisted data, else what it started with. */
  data(): PluginData;
}

export async function makeDevice(world: World, options: DeviceOptions = {}): Promise<Device> {
  const { createSyncEngine } = await loadSync();
  const log = newLog();
  const network = { online: true };
  const vault = options.vault ?? new FakeVault(options.files ?? {}, log);
  vault.log = log;
  const initial: PluginData = options.from
    ? structuredClone(options.from)
    : {
        address: options.address ?? world.address,
        user: options.user ?? world.user,
        token: options.token === undefined ? world.token : options.token,
        cursor: options.cursor ?? null,
        notes: structuredClone(options.notes ?? {}),
      };
  const unlock = options.unlock === undefined ? new TestUnlock(world.keys) : (options.unlock ?? new TestUnlock(null));
  const saved: PluginData[] = [];
  const notices: string[] = [];
  const deps: SyncDeps = {
    vault,
    http: nexusOver(log, network),
    data: structuredClone(initial),
    persist: async (data) => {
      saved.push(structuredClone(data ?? deps.data));
    },
    notify: (message) => notices.push(message),
    device: options.name ?? DEVICE_NAME,
    now: () => new Date(NOW),
    unlock,
  };
  return {
    vault,
    engine: createSyncEngine(deps),
    log,
    notices,
    saved,
    network,
    deps,
    unlock,
    data: () => saved.at(-1) ?? initial,
  };
}

/** A device that has done its first sync over `files`, then been closed and opened again: the way most tests begin. */
export async function syncedDevice(world: World, files: Record<string, string> = {}, options: DeviceOptions = {}): Promise<Device> {
  const first = await makeDevice(world, { ...options, files });
  await first.engine.sync();
  return makeDevice(world, { ...options, vault: first.vault, from: first.data(), unlock: first.unlock });
}

// ── small helpers the tests share ────────────────────────────────────────────

/** Nexus's live notes by id, each opened with the world's key: what the vault's owner would read. */
export async function nexusNotes(world: World): Promise<Record<string, { path: string; text: string; version: number }>> {
  const listed = bodyOf(await world.owner.list()).notes as Array<{ id: string }>;
  const out: Record<string, { path: string; text: string; version: number }> = {};
  for (const { id } of listed) {
    const note = bodyOf(await world.owner.note(id));
    out[id] = { ...(await openBlob(world.keys, id, note.blob)), version: note.version };
  }
  return out;
}

/** Nexus's live notes as `path -> text`, opened with the world's key. */
export async function nexusTexts(world: World): Promise<Record<string, string>> {
  return Object.fromEntries(Object.values(await nexusNotes(world)).map((note) => [note.path, note.text]));
}

/** What a save the device sent holds: its id and base, and the note inside its blob. */
export async function sentNote(world: World, seen: Seen): Promise<{ id: string; base: number; kid: number; path: string; text: string }> {
  const { id, base, kid, blob } = seen.body;
  return { id, base, kid, ...(await openBlob(world.keys, id, blob)) };
}

/** Waits, in real time, until no call to Nexus is open and none has opened for two short ticks. For tests that fake timers. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
export async function quiet(log: Log): Promise<void> {
  let calm = 0;
  for (let guard = 0; guard < 400 && calm < 2; guard++) {
    const before = log.timeline.length;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 25));
    calm = log.inFlight === 0 && log.timeline.length === before ? calm + 1 : 0;
  }
  if (calm < 2) throw new Error("the plugin never went quiet");
}

/** Fake only the timers, never the clock: Nexus reads the clock for its sign-ins and its saves. */
export function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

/** Makes `fetch` throw: the plugin runs inside Obsidian, where the only way out is `requestUrl`. */
export function forbidFetch(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("the plugin called fetch: it has to use Obsidian's requestUrl, which the tests hand it");
  });
}
