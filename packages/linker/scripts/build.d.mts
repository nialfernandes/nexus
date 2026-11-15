/** Builds the nexus-linker command, a Node program, at `outfile`. */
export function buildCommand(outfile: string): Promise<void>;
/** Builds the Worker at `outfile`, and copies the WebAssembly it imports beside it as nexus-agent.wasm. */
export function buildWorker(outfile: string): Promise<void>;
/** SHA-256 of a file, as 64 lower case hex characters. */
export function sha256Of(file: string): Promise<string>;
