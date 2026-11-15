// The job as a Cloudflare Worker that runs on a cron trigger (wrangler.example.toml). It has no web route: nothing can call it, it only
// wakes on the schedule. Its settings are the Worker's variables, and its keys and tokens are its secrets. The model's key may be a plain
// secret or a Secrets Store binding (an object whose `get()` answers it).

import wasm from "@nexus/agent/nexus-agent.wasm";
import { runJob } from "./job";
import { summaryOf } from "./run";
import { withModelKeyRead, type Environment } from "./settings";

export default {
  async scheduled(_controller: unknown, env: Environment): Promise<void> {
    const report = await runJob({ env: await withModelKeyRead(env), wasm, log: (line) => console.log(line) });
    for (const line of summaryOf(report)) console.log(line);
  },
};
