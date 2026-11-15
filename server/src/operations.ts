// The store's calls, each made as a Caller and answered with the JSON a route sends. The routes (routes.ts) and an
// app inside the Worker (app-store.ts) both go through here, so the two can never disagree about what a call does
// or what it answers. A refusal is thrown as a Refusal, which a route turns into `{ error }` and an app gets as a
// rejected call.

import { changeEntry, historyEntry, listEntry, noteAnswer, wrapEntry } from "./answers";
import type { NexusHost } from "./ports";
import type { Caller } from "./caller";
import * as store from "./store";
import * as wraps from "./wraps";

export interface Answered {
  status: number;
  json: unknown;
}

const ok = (json: unknown): Answered => ({ status: 200, json });

export const operations = {
  async save(host: NexusHost, caller: Caller, input: store.SaveInput): Promise<Answered> {
    return ok(await store.save(host, caller, input));
  },
  async note(host: NexusHost, caller: Caller, id: unknown, version?: number): Promise<Answered> {
    return ok(noteAnswer(await store.readNote(host, caller, id, version)));
  },
  async history(host: NexusHost, caller: Caller, id: unknown): Promise<Answered> {
    const history = await store.readHistory(host, caller, id);
    return ok({ id: history.id, versions: history.versions.map(historyEntry) });
  },
  async list(host: NexusHost, caller: Caller): Promise<Answered> {
    return ok({ notes: (await store.list(host, caller)).map(listEntry) });
  },
  async changes(host: NexusHost, caller: Caller, after: unknown, limit: unknown): Promise<Answered> {
    const { rows, next } = await store.changes(host, caller, after, limit);
    return ok({ changes: rows.map(changeEntry), next });
  },
  async remove(host: NexusHost, caller: Caller, input: { id?: unknown; base?: unknown }): Promise<Answered> {
    return ok(await store.remove(host, caller, input));
  },
  async wraps(host: NexusHost): Promise<Answered> {
    return ok({ vaultId: await wraps.vaultId(host), wraps: (await wraps.listWraps(host)).map(wrapEntry) });
  },
  async setWrap(host: NexusHost, caller: Caller, input: Record<string, unknown>): Promise<Answered> {
    return ok(await wraps.setWrap(host, caller, input));
  },
  async removeWrap(host: NexusHost, input: Record<string, unknown>): Promise<Answered> {
    return ok(await wraps.removeWrap(host, input));
  },
};
