// The job as a whole: the settings read, the vault opened with the agent's own key, one pass run, the vault closed. The Worker and the
// command both run this, so what a cron trigger does and what a person does in a terminal cannot differ.

import { AgentVault, type FetchLike } from "@nexus/agent";
import type { ModelFetch } from "./model";
import { runLinker, type RunReport } from "./run";
import { readSettings, readVaultSettings, type Environment } from "./settings";

export interface JobOptions {
  /** Where the settings are: a command's environment, or a Worker's bindings and secrets. */
  env: Environment;
  log: (line: string) => void;
  /** How Nexus is reached. The runtime's `fetch` when left out. */
  fetchNexus?: FetchLike;
  /** How the model is reached. The runtime's `fetch` when left out. */
  fetchModel?: ModelFetch;
  /** What time it is. The clock's own when left out. */
  now?: () => Date;
  /** In a Cloudflare Worker, libsodium's WebAssembly, compiled: `import wasm from "@nexus/agent/nexus-agent.wasm"`. */
  wasm?: WebAssembly.Module;
}

export async function runJob(options: JobOptions): Promise<RunReport> {
  const settings = readSettings(options.env);
  const vaultSettings = readVaultSettings(options.env);
  const vault = await AgentVault.open({
    ...vaultSettings,
    name: "linker",
    ...(options.fetchNexus === undefined ? {} : { fetch: options.fetchNexus }),
    ...(options.wasm === undefined ? {} : { wasm: options.wasm }),
  });
  try {
    return await runLinker({ store: vault, settings, fetchModel: options.fetchModel ?? ((url, init) => fetch(url, init)), log: options.log, ...(options.now === undefined ? {} : { now: options.now }) });
  } finally {
    vault.close();
  }
}
