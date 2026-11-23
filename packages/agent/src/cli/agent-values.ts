// The four values an agent needs to read and write notes, as the lines the other commands read them from: one NAME=value to a line, the
// names being the environment variables `read`, `write` and `list` take (labels.ts). `set-up-agent` prints them for the person to copy to
// the agent, and `join` prints them on the agent itself. They are written to standard output and nothing else is, so they can be sent
// straight to a file or a secrets manager.

import type { Io } from "./io";
import { ENV } from "./labels";

export interface AgentValues {
  address: string;
  token: string;
  /** Base64. */
  privateKey: string;
  /** Base64. */
  approval: string;
}

/** Prints the four values, each on its own line. */
export function writeAgentValues(io: Io, values: AgentValues): void {
  io.stdout.write(`${ENV.address}=${values.address}\n`);
  io.stdout.write(`${ENV.token}=${values.token}\n`);
  io.stdout.write(`${ENV.privateKey}=${values.privateKey}\n`);
  io.stdout.write(`${ENV.approval}=${values.approval}\n`);
}
