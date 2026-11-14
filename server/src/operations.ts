// The store's calls, each made as a Caller and answered with the JSON a route sends. The routes (routes.ts) and an
// app inside the Worker (app-store.ts) both go through here, so the two can never disagree about what a call does
// or what it answers. A refusal is thrown as a Refusal, which a route turns into `{ error }` and an app gets as a
// rejected call.

import { changeEntry, historyEntry, listEntry, noteAnswer } from "./answers";
import { vaultFolder } from "./paths";
import type { NexusHost } from "./ports";
import type { Caller } from "./rights";
import * as store from "./store";

export interface Answered {
  status: number;
  json: unknown;
}

const ok = (json: unknown): Answered => ({ status: 200, json });

export const operations = {
  /** A clash is answered 409 with both texts: a save that was kept, but not merged. */
  async save(host: NexusHost, caller: Caller, input: store.SaveInput): Promise<Answered> {
    const answer = await store.save(host, caller, input);
    return { status: answer.result === "clash" ? 409 : 200, json: answer };
  },
  async note(host: NexusHost, caller: Caller, path: unknown, version?: number): Promise<Answered> {
    return ok(noteAnswer(await store.readNote(host, caller, path, version)));
  },
  async history(host: NexusHost, caller: Caller, path: unknown): Promise<Answered> {
    const history = await store.readHistory(host, caller, path);
    return ok({ path: history.path, versions: history.versions.map(historyEntry) });
  },
  async list(host: NexusHost, caller: Caller, folder: unknown): Promise<Answered> {
    return ok({ notes: (await store.list(host, caller, vaultFolder(folder))).map(listEntry) });
  },
  async search(host: NexusHost, caller: Caller, q: unknown): Promise<Answered> {
    return ok({ results: await store.search(host, caller, q) });
  },
  async changes(host: NexusHost, caller: Caller, after: unknown, limit: unknown): Promise<Answered> {
    const { rows, next } = await store.changes(host, caller, after, limit);
    return ok({ changes: rows.map(changeEntry), next });
  },
  async move(host: NexusHost, caller: Caller, from: unknown, to: unknown): Promise<Answered> {
    return ok(await store.move(host, caller, from, to));
  },
  async remove(host: NexusHost, caller: Caller, path: unknown): Promise<Answered> {
    return ok(await store.remove(host, caller, path));
  },
};
