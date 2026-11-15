// What an agent imports: the vault, and the few things that go with it. Runs in Node and in a Cloudflare Worker.

export { AgentVault, type AgentOptions, type NoteContent, type NoteRef, type UpdateResult, type WriteResult } from "./vault";
export { AgentError, type AgentErrorCode } from "./errors";
export type { FetchLike } from "./nexus";
export { isSafeNotePath } from "./paths";

import { AgentVault, type AgentOptions } from "./vault";

/** The same as `AgentVault.open`. */
export const openAgentVault = (options: AgentOptions): Promise<AgentVault> => AgentVault.open(options);
