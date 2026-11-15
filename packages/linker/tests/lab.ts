// What the job's tests stand on: the real server code over an in-memory database (the agent's test world, read here and not changed),
// a stand-in model server on a port of this machine, a writer that puts transcript notes in the vault the way the writer of
// transcript notes does (an agent that makes a note), and a reader that sees what the vault holds with the plugin's own way of reading.

import { AgentVault, type FetchLike, type NoteRef } from "@nexus/agent";
import { nexusTexts } from "../../../plugin/tests/world";
import { agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type World } from "../../agent/tests/world";
import { runJob } from "../src/job";
import type { ModelFetch } from "../src/model";
import type { RunReport } from "../src/run";
import { SETTING, VAULT_SETTING } from "../src/settings";
import { startModelServer, type ModelServer } from "./model-server";

export const realFetch: ModelFetch = (url, init) => fetch(url, init);

export interface Lab {
  world: World;
  model: ModelServer;
  credentials: AgentCredentials;
  /** The environment the job is run with. */
  env: Record<string, string>;
  /** How Nexus is reached: the real server code, as the agent's own tests reach it. */
  fetchNexus: FetchLike;
  /** Every call made to Nexus, in order. */
  seen: ReturnType<typeof fetchOverNexus>["seen"];
  /** A second writer of the vault: puts notes in, and edits them as a person would. */
  writer: AgentVault;
  /** Puts a note in the vault at version 1. */
  seed(path: string, text: string): Promise<NoteRef>;
  /** One pass of the job, with the lines it logged. */
  run(env?: Record<string, string>): Promise<{ report: RunReport; logs: string[] }>;
  /** What the vault holds, by path. */
  texts(): Promise<Record<string, string>>;
  /** Every note's id and version, by path. */
  refs(): Promise<NoteRef[]>;
  close(): Promise<void>;
}

export async function openLab(env: Record<string, string> = {}): Promise<Lab> {
  const world = await openWorld();
  await setUpVault(world);
  const credentials = await agentCredentials(world, "the linker under test");
  const { fetch: fetchNexus, seen } = fetchOverNexus();
  const model = await startModelServer();
  const open = () =>
    AgentVault.open({ address: credentials.address, token: credentials.token, privateKey: credentials.privateKey, approval: credentials.approval, fetch: fetchNexus });
  const writer = await open();
  const base: Record<string, string> = {
    [VAULT_SETTING.address]: credentials.address,
    [VAULT_SETTING.token]: credentials.token,
    [VAULT_SETTING.privateKey]: credentials.privateKey,
    [VAULT_SETTING.approval]: credentials.approval,
    [SETTING.folders]: "Hush/",
    [SETTING.modelAddress]: model.address,
    [SETTING.modelKey]: "a-key-for-the-stand-in",
    [SETTING.modelName]: "a-model-name",
    ...env,
  };
  return {
    world,
    model,
    credentials,
    env: base,
    fetchNexus,
    seen,
    writer,
    seed: (path, text) => writer.createNote(path, text),
    run: async (more = {}) => {
      const logs: string[] = [];
      const report = await runJob({ env: { ...base, ...more }, log: (line) => logs.push(line), fetchNexus, fetchModel: realFetch });
      return { report, logs };
    },
    texts: () => nexusTexts(world),
    refs: async () => {
      const reader = await open();
      try {
        return await reader.listNotes();
      } finally {
        reader.close();
      }
    },
    close: async () => {
      writer.close();
      await model.close();
    },
  };
}

/** A model's answer: the items as the JSON list the instructions ask for. */
export const listOf = (...items: Array<Record<string, unknown>>): string => JSON.stringify(items);
