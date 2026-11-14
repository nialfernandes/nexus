// Nexus for an app that runs inside the same process as Nexus. The app does not use a token: it is handed the store's
// calls under its own identity's name, and the same folder rights apply to it as to anyone holding a token.
//
// Each call resolves with exactly the JSON the matching route sends in a 200 answer (a save that clashed resolves
// with the clash, as the route's 409 body is that same JSON), and rejects with a Refusal, an Error whose `status`
// is the route's status and whose message is the route's `error`. The identity's rights are read again on every
// call, so a change to them is held to from the next call. An identity that does not exist holds no rights, so
// every call it makes is refused 403.

import { loadCaller } from "./identities";
import { operations } from "./operations";
import type { NexusHost } from "./ports";

export interface AppStore {
  save(path: string, text: string, options?: { base?: number; resolves?: number }): Promise<unknown>;
  note(path: string, version?: number): Promise<unknown>;
  history(path: string): Promise<unknown>;
  list(folder?: string): Promise<unknown>;
  search(q: string): Promise<unknown>;
  changes(after?: string | number, limit?: number): Promise<unknown>;
  move(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}

export function appStore(host: NexusHost, identity: string): AppStore {
  const as = () => loadCaller(host, identity);
  return {
    save: async (path, text, options = {}) => (await operations.save(host, await as(), { path, text, ...options })).json,
    note: async (path, version) => (await operations.note(host, await as(), path, version)).json,
    history: async (path) => (await operations.history(host, await as(), path)).json,
    list: async (folder) => (await operations.list(host, await as(), folder)).json,
    search: async (q) => (await operations.search(host, await as(), q)).json,
    changes: async (after, limit) => (await operations.changes(host, await as(), after, limit)).json,
    move: async (from, to) => (await operations.move(host, await as(), from, to)).json,
    remove: async (path) => (await operations.remove(host, await as(), path)).json,
  };
}
