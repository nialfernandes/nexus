// Nexus for an app that runs inside the same process as Nexus. The app does not use a token: it is handed the store's
// calls under its own identity's name, and what it saves is as encrypted as anyone's: it passes blobs, never text.
//
// Each call resolves with exactly the JSON the matching route sends in a 200 answer, and rejects with a Refusal, an
// Error whose `status` is the route's status, whose message is the route's `error` and whose `details` hold what the
// route adds beside it (a refused save's `current`). An identity that does not exist is refused 403 on every call.

import { loadCaller, identityExists } from "./identities";
import { operations } from "./operations";
import type { NexusHost } from "./ports";
import { Refusal } from "./refusal";
import type { SaveInput } from "./store";

export interface AppStore {
  save(input: SaveInput): Promise<unknown>;
  note(id: string, version?: number): Promise<unknown>;
  history(id: string): Promise<unknown>;
  list(): Promise<unknown>;
  changes(after?: string | number, limit?: number): Promise<unknown>;
  remove(id: string, base: number): Promise<unknown>;
  wraps(): Promise<unknown>;
}

export function appStore(host: NexusHost, identity: string): AppStore {
  const as = async () => {
    if (!(await identityExists(host, identity))) throw new Refusal(403, "Nexus has no identity with that name.");
    return loadCaller(host, identity);
  };
  return {
    save: async (input) => (await operations.save(host, await as(), input)).json,
    note: async (id, version) => (await operations.note(host, await as(), id, version)).json,
    history: async (id) => (await operations.history(host, await as(), id)).json,
    list: async () => (await operations.list(host, await as())).json,
    changes: async (after, limit) => (await operations.changes(host, await as(), after, limit)).json,
    remove: async (id, base) => (await operations.remove(host, await as(), { id, base })).json,
    wraps: async () => (await operations.wraps(host)).json,
  };
}
